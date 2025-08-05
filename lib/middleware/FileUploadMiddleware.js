const busboy = require("busboy");
const fs = require("fs");

function fileUpload() {
  return async (request, reply) => {
    console.log('FileUpload middleware called');
    console.log('Content-Type:', request.headers["content-type"]);
    
    if (!request.headers["content-type"]?.startsWith("multipart/form-data")) {
      console.log('Not multipart, skipping');
      return;
    }

    console.log('Processing multipart upload');
    
    try {
      return new Promise((resolve, reject) => {
        const bb = busboy({ headers: request.headers });
        request.body = request.body || {};
        
        bb.on("file", (fieldname, file, info) => {
          const filePath = `${request.tmpDir}/${info.filename}`;

          console.log(`Uploading file: ${filePath}`);
          
          const writeStream = fs.createWriteStream(filePath);
          file.pipe(writeStream);

          const fileUpload = { filename: info.filename, encoding: info.encoding, mimeType: info.mimeType, path: filePath };
          request.body[fieldname] = request.body[fieldname] || [];
          request.body[fieldname].push(fileUpload);
          
          writeStream.on('error', (err) => {
            console.error('Write stream error:', err);
            reject(err);
          });
        });

        bb.on("finish", () => {
          console.log('Busboy finished');
          resolve();
        });

        bb.on("error", (err) => {
          console.error('Busboy error:', err);
          reject(err);
        });

        console.log('Piping request to busboy');
        request.raw.pipe(bb);
      });
    } catch (error) {
      console.error('FileUpload middleware error:', error);
      throw error;
    }
  };
}

module.exports = { fileUpload };
