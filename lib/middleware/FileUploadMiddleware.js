const busboy = require("busboy");
const fs = require("fs");

function fileUpload() {
  return (req, res, next) => {
    if (!req.headers["content-type"]?.startsWith("multipart/form-data")) {
      return next();
    }

    const bb = busboy({ headers: req.headers });
    bb.on("file", (fieldname, file, info) => {
      const filePath = `${req.tmpDir}/${info.filename}`;

      console.log(`Uploading file: ${filePath}`);
      file.pipe(fs.createWriteStream(filePath));

      const fileUpload = { filename: info.filename, encoding: info.encoding, mimeType: info.mimeType, path: filePath };
      req.body[fieldname] = req.body[fieldname] || [];
      req.body[fieldname].push(fileUpload);
    });

    bb.on("finish", () => {
      next();
    });

    req.pipe(bb);
  };
}

module.exports = { fileUpload };
