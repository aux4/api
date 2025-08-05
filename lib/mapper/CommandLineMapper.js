const ViewMapper = require("./ViewMapper");
const Command = require("./Command");

const API_PATH_PREFIX_LENGTH = "/api".length;

class CommandLineMapper extends ViewMapper {
  constructor(app, config) {
    super(app, config);
  }

  canHandle(request) {
    return request.url.startsWith('/api/');
  }

  async handle(request, reply) {
    const method = request.method;
    // Extract path from URL (since we're using /api/* wildcard)
    const path = request.url.substring('/api/'.length).replace(/\?.*$/, '') || '';
    const params = request.query;
    let body = request.body;

    if (request.headers['content-type']?.startsWith('multipart/form-data')) {
      body = {};
      const fs = require('fs');
      
      const parts = request.parts();
      let uploadedFiles = 0;
      const fileLimit = this.config.server?.limits?.files || 5;

      try {
        for await (const part of parts) {
          if (part.type === 'file') {
            uploadedFiles++;
            
            if (uploadedFiles > fileLimit) {
              await part.toBuffer();
              
              return reply.status(413).send({ message: `Too many files uploaded. Maximum allowed: ${fileLimit}`, error: 'Payload Too Large', statusCode: 413 });
            }

            const filename = part.filename;
            const filePath = `${request.tmpDir}/${filename}`;
            
            const buffer = await part.toBuffer();
            fs.writeFileSync(filePath, buffer);
            
            const fileUpload = {
              filename: filename,
              encoding: part.encoding,
              mimeType: part.mimetype,
              path: filePath
            };
            
            body[part.fieldname] = body[part.fieldname] || [];
            body[part.fieldname].push(fileUpload);
          } else {
            body[part.fieldname] = part.value;
          }
        }
      } catch (error) {
        return reply.status(400).send({ error: 'Error processing multipart data: ' + error.message });
      }
    }

    const pathConfig = (this.config.api && this.config.api[`${method} /${path}`]) || {};
    const responseObj = {
      contentType: request.headers.accept
    };

    setHeaders(reply, pathConfig, responseObj);

    if (!responseObj.contentType || responseObj.contentType.includes("*/*")) {
      responseObj.contentType = "application/json";
    }

    const view = this.getView(pathConfig, path);

    try {
      const { data, exitCode } = await executeCommand(path, params, body, request.tmpDir);
      
      if (view) {
        return reply.view(view.name, { layout: view.layout, ...convertOutputToJSON(data) });
      } else {
        const response = convertResponse(data, pathConfig, request, reply);
        const responseStatusMapping = getResponseStatusMapping(pathConfig);

        return reply.status(responseStatusMapping[exitCode]).type(responseObj.contentType).send(response);
      }
    } catch (error) {
      return reply.status(500).send({ error: error.message });
    }
  }

  build() {
    const processor = async (request, reply) => {
      const method = request.method;
      const path = `/${request.params.path || ''}`;
      const params = request.query;
      const body = request.body;

      const pathConfig = (this.config.api && this.config.api[`${method} ${path}`]) || {};
      const responseObj = {
        contentType: request.headers.accept
      };

      setHeaders(reply, pathConfig, responseObj);

      if (!responseObj.contentType || responseObj.contentType.includes("*/*")) {
        responseObj.contentType = "application/json";
      }

      const view = this.getView(pathConfig, path);

      try {
        const { data, exitCode } = await executeCommand(path, params, body, request.tmpDir);
        
        if (view) {
          return reply.view(view.name, { layout: view.layout, ...convertOutputToJSON(data) });
        } else {
          const response = convertResponse(data, pathConfig, request, reply);
          const responseStatusMapping = getResponseStatusMapping(pathConfig);

          return reply.status(responseStatusMapping[exitCode]).type(responseObj.contentType).send(response);
        }
      } catch (error) {
        return reply.status(500).send({ error: error.message });
      }
    };

    Object.values(this.methods).forEach(method => {
      method("/api/:path*", processor);
    });
  }
}

function convertOutputToJSON(output) {
  try {
    return JSON.parse(output);
  } catch (e) {
    return { data: output };
  }
}

function getResponseStatusMapping(pathConfig) {
  const responseStatus = pathConfig.response?.status || 200;
  const defaultResponseStatusMapping = { 0: responseStatus, 1: 500, 126: 403, 127: 404 };

  return typeof responseStatus === "object"
    ? { ...defaultResponseStatusMapping, ...responseStatus }
    : defaultResponseStatusMapping;
}

function convertResponse(response, pathConfig, request, reply) {
  if (pathConfig.output?.base64) {
    return Buffer.from(response, "base64");
  }

  const acceptEncoding = request.headers["accept-encoding"];
  const isAcceptEncodingBase64 = acceptEncoding && acceptEncoding === "base64";

  if (isAcceptEncodingBase64) {
    reply.header("Content-Encoding", "base64");
    return Buffer.from(response).toString("base64");
  }

  return response;
}

async function executeCommand(path, params, input, tmpDir) {
  const command = path.split("/").join(" ").trim();
  const args = Object.entries(params)
    .concat([["tmpDir", tmpDir]])
    .map(([key, value]) => `--${key} "${value}"`)
    .join(" ");

  let response, exitCode;

  try {
    const output = await Command.execute(`aux4 ${command} ${args}`.trim(), input, { detached: true });
    exitCode = output.exitCode || 0;
    response = output.stdout;
  } catch (e) {
    exitCode = e.exitCode || 1;
    response = e.stderr;
  }

  return { data: response, exitCode };
}

function setHeaders(reply, config, responseObj) {
  if (config.response?.headers) {
    Object.entries(config.response?.headers).forEach(([key, value]) => {
      if (key.toLowerCase() === "content-type") {
        responseObj.contentType = value;
      }
      reply.header(key, value);
    });
  }
}

module.exports = CommandLineMapper;
