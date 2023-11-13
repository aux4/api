const Mapper = require("./Mapper");
const { Command } = require("@aux4/engine");

class CommandLineMapper extends Mapper {
  constructor(app, config) {
    super(app, config);
  }

  build() {
    const processor = async (req, res) => {
      const method = req.method;
      const path = req.path;
      const params = req.query;
      const body = req.body;

      const pathConfig = (this.config.api && this.config.api[`${method} ${path}`]) || {};

      let contentType = req.headers.accept;

      if (this.config.response?.headers) {
        Object.entries(this.config.response?.headers).forEach(([key, value]) => {
          if (key.toLowerCase() === "content-type" && contentType === "*/*") {
            contentType = value;
          }
          res.set(key, value);
        });
      }

      if (!contentType || contentType === "*/*") {
        contentType = "application/json";
      }

      const acceptEncoding = req.headers["accept-encoding"];
      const isAcceptEncodingBase64 = acceptEncoding && acceptEncoding === "base64";

      const command = path.split("/").join(" ").trim();
      const args = Object.entries(params)
        .map(([key, value]) => `--${key} "${value}"`)
        .join(" ");

      let response, exitCode;

      try {
        const input = typeof body === "object" ? JSON.stringify(body) : body;
        console.log("path", req.path);
        console.log("input", input);
        console.log("command", `aux4 ${command} ${args}`.trim());

        const output = await Command.execute(`aux4 ${command} ${args}`.trim(), input);
        exitCode = output.exitCode || 0;
        response = output.stdout;
      } catch (e) {
        exitCode = e.exitCode || 1;
        response = e.stderr;
      }

      if (pathConfig.output?.base64) {
        response = Buffer.from(response, "base64");
      }

      if (pathConfig.response?.headers) {
        Object.entries(pathConfig.response.headers).forEach(([key, value]) => {
          if (key.toLowerCase() === "content-type") {
            contentType = value;
          }
          res.set(key, value);
        });
      }

      if (isAcceptEncodingBase64) {
        res.set("Content-Encoding", "base64");
        response = Buffer.from(response).toString("base64");
      }

      const responseStatus = pathConfig.response?.status || 200;

      const responseStatusMapping =
        typeof responseStatus === "object" ? responseStatus : { 0: responseStatus, 1: 500, 126: 403, 127: 404 };

      res.status(responseStatusMapping[exitCode]).type(contentType).send(response);
    };

    Object.values(this.methods).forEach(method => {
      method("*", processor);
    });
  }
}

module.exports = CommandLineMapper;
