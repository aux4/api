const childProcess = require("child_process");

class Command {
  static killProcessGroup(child) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }

  // When AUX4_COMMAND_DAEMON_DIR is set (the cloud lambda-loop runtime points it
  // at a WRITABLE dir, e.g. /tmp/aux4d, where a warm aux4 daemon listens), route
  // commands are spawned from that dir with the daemon ENABLED so each `aux4 …`
  // reuses the warm daemon instead of cold-starting the CLI (~200ms) every call.
  // The parent process runs daemonless (AUX4_NO_DAEMON=1) and keeps its own CWD
  // (static/views resolve there); only the route-command CHILDREN switch CWD to
  // the daemon dir (that's where the aux4 client discovers the socket) and drop
  // AUX4_NO_DAEMON. No-op when the env var is unset (local/CLI use unchanged).
  static applyDaemonOptions(options) {
    const dir = process.env.AUX4_COMMAND_DAEMON_DIR;
    if (!dir) return options;
    options.cwd = dir;
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
    Command.applyDaemonOptions(options);

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
