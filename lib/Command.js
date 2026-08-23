const childProcess = require("child_process");

class Command {
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
    const env = { ...process.env };
    delete env.AUX4_NO_DAEMON;
    options.env = env;
    return options;
  }

  static async execute(command, stdinData, timeout) {
    return new Promise((resolve, reject) => {
      const out = {};

      const options = { maxBuffer: Infinity };
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

  static stream(command, stdinData, timeout) {
    const options = { maxBuffer: Infinity };
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
