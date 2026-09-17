const childProcess = require("child_process");

class Command {
  // Linux caps a single argv/env string at MAX_ARG_STRLEN (128 KiB) and the
  // whole argv+env block at ARG_MAX. Overflowing either makes execve fail with a
  // raw E2BIG which, uncaught, escapes this Lambda as {"errorMessage":"spawn
  // E2BIG"} with no actionable context. Guard both before spawning so an
  // oversized command produces a clear message instead of an opaque crash.
  static MAX_ARG_STRLEN = 128 * 1024;
  static MAX_ARGV_ENV_BYTES = 1024 * 1024;

  // Estimate the bytes execve will need: every argv and env string is laid out
  // as "value\0", so count each string's byte length plus its separator.
  static argvEnvSize(file, args = [], env = {}) {
    let total = Buffer.byteLength(String(file)) + 1;
    let maxArg = 0;
    for (const arg of args) {
      const len = Buffer.byteLength(typeof arg === "string" ? arg : String(arg));
      total += len + 1;
      if (len > maxArg) maxArg = len;
    }
    for (const [key, value] of Object.entries(env || {})) {
      if (value === undefined || value === null) continue;
      total += Buffer.byteLength(String(key)) + Buffer.byteLength(String(value)) + 2;
    }
    return { total, maxArg };
  }

  static killProcessGroup(child) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }

  // When the server owns a warm aux4 daemon (CommandDaemon set AUX4_DAEMON_SOCKET),
  // route commands should reuse it instead of cold-starting the CLI. They already
  // inherit AUX4_DAEMON_SOCKET (so they discover the socket), but the cloud runtime
  // runs the parent daemonless via AUX4_NO_DAEMON=1, which children would inherit
  // and thus skip the daemon — so strip it for the children. Crucially this does
  // NOT change the child's working directory (route commands keep their CWD).
  // No-op when no daemon socket is configured (local/CLI use unchanged).
  static applyDaemonOptions(options) {
    if (!process.env.AUX4_DAEMON_SOCKET) return options;
    const env = { ...(options.env || process.env) };
    delete env.AUX4_NO_DAEMON;
    options.env = env;
    return options;
  }

  static async execute(command, stdinData, timeout, envOverrides) {
    return new Promise((resolve, reject) => {
      const out = {};

      const options = {
        maxBuffer: Infinity,
        env: envOverrides ? { ...process.env, ...envOverrides } : process.env
      };
      if (process.platform !== "win32") options.detached = true;
      Command.applyDaemonOptions(options);

      const child = childProcess.exec(command, options, (err, stdout, stderr) => {
        if (timer) clearTimeout(timer);
        if (out.timedOut) {
          resolve({ exitCode: 1, stdout, stderr: stderr || "Command timed out" });
        } else if (err) {
          resolve({ exitCode: out.exitCode || 1, stdout, stderr });
        } else {
          resolve({ exitCode: out.exitCode || 0, stdout, stderr });
        }
      });

      let timer;
      if (timeout) {
        timer = setTimeout(() => {
          out.timedOut = true;
          Command.killProcessGroup(child);
        }, timeout);
      }

      child.on("exit", exitCode => {
        out.exitCode = exitCode;
      });

      if (stdinData !== undefined && stdinData !== null && stdinData !== "") {
        const data = typeof stdinData === "string" ? stdinData : JSON.stringify(stdinData);
        child.stdin.write(data);
        child.stdin.end();
      } else {
        child.stdin.end();
      }
    });
  }

  // Structured execution path for trusted runtime integrations (for example a
  // Step Functions task invoking its own Cloud VM). Unlike execute(), this never
  // feeds a command string to a shell: the executable and every argument remain
  // separate all the way to execFile.
  static async executeFile(file, args = [], stdinData, timeout, envOverrides) {
    return new Promise(resolve => {
      const out = {};
      const options = {
        maxBuffer: Infinity,
        env: envOverrides ? { ...process.env, ...envOverrides } : process.env
      };
      Command.applyDaemonOptions(options);

      // Reject early with an actionable message rather than letting execve throw
      // a raw E2BIG that escapes uncaught as an opaque Lambda error.
      const { total, maxArg } = Command.argvEnvSize(file, args, options.env);
      if (maxArg > Command.MAX_ARG_STRLEN || total > Command.MAX_ARGV_ENV_BYTES) {
        resolve({
          exitCode: 1,
          stdout: "",
          stderr:
            `Command is too large to spawn (${total} bytes across argv+env, largest single ` +
            `argument ${maxArg} bytes; limits total ${Command.MAX_ARGV_ENV_BYTES}, per-argument ` +
            `${Command.MAX_ARG_STRLEN}). Pass large parameters via a file or stdin, not argv.`
        });
        return;
      }

      let timer;
      try {
        const child = childProcess.execFile(file, args, options, (err, stdout, stderr) => {
          if (timer) clearTimeout(timer);
          if (out.timedOut) {
            resolve({ exitCode: 1, stdout, stderr: stderr || "Command timed out" });
          } else if (err) {
            resolve({ exitCode: Number.isInteger(err.code) ? err.code : 1, stdout, stderr });
          } else {
            resolve({ exitCode: 0, stdout, stderr });
          }
        });

        if (timeout) {
          timer = setTimeout(() => {
            out.timedOut = true;
            child.kill("SIGTERM");
          }, timeout);
        }

        if (stdinData !== undefined && stdinData !== null && stdinData !== "") {
          child.stdin.end(typeof stdinData === "string" ? stdinData : JSON.stringify(stdinData));
        } else {
          child.stdin.end();
        }
      } catch (error) {
        // execFile can fail synchronously (E2BIG among others). Convert that into
        // the same resolved shape so the caller sees a clean non-zero result.
        if (timer) clearTimeout(timer);
        resolve({
          exitCode: 1,
          stdout: "",
          stderr: error && error.message ? error.message : String(error)
        });
      }
    });
  }

  static stream(command, stdinData, timeout, envOverrides) {
    const options = {
      maxBuffer: Infinity,
      env: envOverrides ? { ...process.env, ...envOverrides } : process.env
    };
    if (process.platform !== "win32") options.detached = true;
    // NB: streaming responses (SSE) cannot go through the warm daemon (its
    // frame-based stdio does not stream), so stream() always cold-spawns.

    const child = childProcess.exec(command, options);

    if (timeout) {
      const timer = setTimeout(() => {
        Command.killProcessGroup(child);
      }, timeout);
      child.on("exit", () => clearTimeout(timer));
    }

    if (stdinData !== undefined && stdinData !== null && stdinData !== "") {
      const data = typeof stdinData === "string" ? stdinData : JSON.stringify(stdinData);
      child.stdin.write(data);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    return child;
  }
}

module.exports = Command;
