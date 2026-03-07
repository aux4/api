const fs = require("fs");
const Command = require("../Command");
const { buildRestEvent } = require("./EventBuilder");

class RestHandler {
  constructor(config) {
    this.config = config;
    this.routes = [];
    this.fileLimit = config.server?.limits?.files || 5;
  }

  compile() {
    const api = this.config.api || {};

    for (const [route, routeConfig] of Object.entries(api)) {
      const spaceIndex = route.indexOf(" ");
      const method = route.substring(0, spaceIndex).toUpperCase();
      const pattern = route.substring(spaceIndex + 1);

      const paramNames = [];
      const regexStr = pattern.replace(/\{(\w+)\}/g, (_, name) => {
        paramNames.push(name);
        return "([^/]+)";
      });

      const regex = new RegExp("^" + regexStr + "$");

      this.routes.push({
        method,
        regex,
        paramNames,
        command: routeConfig.command,
        config: routeConfig
      });
    }
  }

  match(method, path) {
    for (const route of this.routes) {
      if (route.method !== method) continue;

      const match = path.match(route.regex);
      if (match) {
        const pathParameters = {};
        route.paramNames.forEach((name, i) => {
          pathParameters[name] = match[i + 1];
        });
        return { route, pathParameters };
      }
    }
    return null;
  }

  register(app) {
    this.compile();

    app.route({
      method: ["GET", "POST", "PUT", "DELETE", "PATCH"],
      url: "/api/*",
      handler: async (request, reply) => {
        return this.handle(request, reply);
      }
    });
  }

  async handle(request, reply) {
    const urlPath = request.url.replace(/\?.*$/, "");
    const apiPath = urlPath.replace(/^\/api/, "") || "/";

    const result = this.match(request.method, apiPath);
    if (!result) {
      return reply.status(404).send({
        message: `Route ${request.method} ${apiPath} not found`,
        error: "Not Found",
        statusCode: 404
      });
    }

    const { route, pathParameters } = result;

    let body = request.body;

    if (request.headers["content-type"]?.startsWith("multipart/form-data")) {
      body = await this.processMultipart(request, reply);
      if (reply.sent) return;
    }

    if (body !== undefined && body !== null) {
      request.body = body;
    }

    const event = buildRestEvent(request, pathParameters);

    if (body && request.headers["content-type"]?.startsWith("multipart/form-data")) {
      event.body = JSON.stringify(body);
    }

    try {
      const { exitCode, stdout, stderr } = await Command.execute(
        route.command,
        JSON.stringify(event)
      );

      if (exitCode !== 0) {
        const errorBody = stdout.trim() || stderr.trim() || "Command failed";
        return reply.status(500).type("text/plain").send(errorBody);
      }

      const output = stdout.trim();

      // data URI: data:<mimetype>[;filename=<name>];base64,<data>
      if (output.startsWith("data:")) {
        const commaIndex = output.indexOf(",");
        if (commaIndex !== -1) {
          const meta = output.substring(5, commaIndex);
          const base64Data = output.substring(commaIndex + 1);
          const parts = meta.split(";");

          const mimetype = parts[0];
          reply.type(mimetype);

          for (const part of parts) {
            if (part.startsWith("filename=")) {
              const filename = part.substring(9);
              reply.header("Content-Disposition", `inline; filename="${filename}"`);
            }
          }

          return reply.status(200).send(Buffer.from(base64Data, "base64"));
        }
      }

      let response;
      try {
        response = JSON.parse(output);
      } catch {
        return reply.status(200).type("text/plain").send(output);
      }

      if (response.statusCode) {
        const headers = response.headers || {};
        const responseBody = response.body || "";

        for (const [key, value] of Object.entries(headers)) {
          reply.header(key, value);
        }

        if (response.isBase64Encoded) {
          return reply.status(response.statusCode).send(Buffer.from(responseBody, "base64"));
        }

        return reply.status(response.statusCode).send(responseBody);
      }

      return reply.status(200).type("application/json").send(JSON.stringify(response));
    } catch (error) {
      return reply.status(500).type("text/plain").send(error.message);
    }
  }

  async processMultipart(request, reply) {
    const body = {};

    try {
      const parts = request.parts();
      let uploadedFiles = 0;

      for await (const part of parts) {
        if (part.type === "file") {
          uploadedFiles++;

          if (uploadedFiles > this.fileLimit) {
            await part.toBuffer();
            reply.status(413).send({
              message: `Too many files uploaded. Maximum allowed: ${this.fileLimit}`,
              error: "Payload Too Large",
              statusCode: 413
            });
            return body;
          }

          const filename = part.filename;
          const filePath = `${request.tmpDir}/${filename}`;

          const buffer = await part.toBuffer();
          fs.writeFileSync(filePath, buffer);

          const fileUpload = {
            filename,
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
      reply.status(400).send({ error: "Error processing multipart data: " + error.message });
    }

    return body;
  }
}

module.exports = RestHandler;
