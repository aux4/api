const fs = require("fs");
const path = require("path");

function requestTemporaryFolder() {
  return async (request, reply) => {
    const tmpDir = path.resolve(path.join(".", ".tmp", request.uuid));
    request.tmpDir = tmpDir;

    fs.mkdirSync(tmpDir, { recursive: true });

    reply.raw.on("finish", () => {
      fs.rmSync(tmpDir, { recursive: true });
    });
  };
}

module.exports = { requestTemporaryFolder };
