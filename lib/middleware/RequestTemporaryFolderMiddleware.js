const fs = require("fs");
const os = require("os");
const path = require("path");

function requestTemporaryFolder() {
  return async (request, reply) => {
    // Root the per-request temp dir at the OS temp dir, which is writable in every
    // environment — including AWS Lambda, where the working directory (/var/task)
    // is read-only. Previously this used the process CWD (`./.tmp`), which 500'd on
    // Lambda with ENOENT/EROFS on the first request.
    const tmpDir = path.join(os.tmpdir(), "aux4-api", request.uuid);
    request.tmpDir = tmpDir;

    fs.mkdirSync(tmpDir, { recursive: true });

    reply.raw.on("finish", () => {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    });
  };
}

module.exports = { requestTemporaryFolder };
