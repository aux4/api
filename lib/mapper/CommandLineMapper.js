const ViewMapper = require("./ViewMapper");
const { Command } = require("@aux4/engine");

const API_PATH_PREFIX_LENGTH = "/api".length;

class CommandLineMapper extends ViewMapper {
  constructor(app, config) {
    super(app, config);
  }

  build() {
    const processor = (req, res, next) => {
      const method = req.method;
      const path = req.path.substring(API_PATH_PREFIX_LENGTH);
      const params = req.query;
      const body = req.body;

      const pathConfig = (this.config.api && this.config.api[`${method} ${path}`]) || {};
      const responseObj = {
        contentType: req.headers.accept
      };

      setHeaders(res, pathConfig, responseObj);

      if (!responseObj.contentType || responseObj.contentType.includes("*/*")) {
        responseObj.contentType = "application/json";
      }

      const view = this.getView(pathConfig, path);

      executeCommand(path, params, body, req.tmpDir)
        .then(({ data, exitCode }) => {
          if (view) {
            res.render(view.name, { layout: view.layout, ...convertOutputToJSON(data) });
          } else {
            const response = convertResponse(data, pathConfig, req, res);
            const responseStatusMapping = getResponseStatusMapping(pathConfig);

            res.status(responseStatusMapping[exitCode]).type(responseObj.contentType).send(response);
          }
        })
        .catch(next);
    };

    Object.values(this.methods).forEach(method => {
      method("/api/*", processor);
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

function convertResponse(response, pathConfig, req, res) {
  if (pathConfig.output?.base64) {
    return Buffer.from(response, "base64");
  }

  const acceptEncoding = req.headers["accept-encoding"];
  const isAcceptEncodingBase64 = acceptEncoding && acceptEncoding === "base64";

  if (isAcceptEncodingBase64) {
    res.set("Content-Encoding", "base64");
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

function setHeaders(res, config, responseObj) {
  if (config.response?.headers) {
    Object.entries(config.response?.headers).forEach(([key, value]) => {
      if (key.toLowerCase() === "content-type" && responseObj.contentType === "*/*") {
        responseObj.contentType = value;
      }
      res.set(key, value);
    });
  }
}

module.exports = CommandLineMapper;
