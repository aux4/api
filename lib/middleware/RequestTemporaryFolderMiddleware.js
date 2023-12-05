const fs = require("fs");
const path = require("path");

function requestTemporaryFolder() {
  return (req, res, next) => {
    const tmpDir = path.resolve(path.join(".", ".tmp", req.uuid));
    req.tmpDir = tmpDir;

    fs.mkdirSync(tmpDir, { recursive: true });

    res.on("finish", () => {
      fs.rmSync(tmpDir, { recursive: true });
    });
    
    next();
  };
}

module.exports = { requestTemporaryFolder };
