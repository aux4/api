const childProcess = require("child_process");

class Command {
  static async execute(command, stdinData) {
    return new Promise((resolve, reject) => {
      const out = {};

      const child = childProcess.exec(command, { maxBuffer: Infinity }, (err, stdout, stderr) => {
        if (err) {
          resolve({ exitCode: out.exitCode || 1, stdout, stderr });
        } else {
          resolve({ exitCode: out.exitCode || 0, stdout, stderr });
        }
      });

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
}

module.exports = Command;
