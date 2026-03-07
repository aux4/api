const fs = require("fs");
const readline = require("readline");
const Command = require("../Command");
const { CommandPoolFullError, CommandPoolTimeoutError } = require("../CommandPool");
const { buildRestEvent } = require("./EventBuilder");
const { isIpAllowed } = require("../middleware/IpAllowlistMiddleware");

class RestHandler {
  constructor(config, rateLimiter, commandPool) {
    this.config = config;
    this.rateLimiter = rateLimiter;
    this.commandPool = commandPool;
    this.routes = [];
    this.fileLimit = config.server?.limits?.files || 5;
    this.defaultTimeout = config.server?.timeout || 30000;
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
    const security = this.config.security || {};

    // API key check
    if (security.apiKey && !route.config.public) {
      const headerName = (security.header || "X-API-Key").toLowerCase();
      const provided = request.headers[headerName];
      if (provided !== security.apiKey) {
        return reply.status(401).send({
          message: "Unauthorized",
          error: "Invalid or missing API key",
          statusCode: 401
        });
      }
    }

    // IP allowlist check (per-route replaces global)
    const allowedIPs = route.config.allowedIPs || security.allowedIPs;
    if (allowedIPs) {
      if (!isIpAllowed(request.ip, allowedIPs)) {
        return reply.status(403).send({
          message: "Forbidden",
          error: "IP not allowed",
          statusCode: 403
        });
      }
    }

    // Per-route rate limit (additive to global)
    if (route.config.rateLimit && this.rateLimiter) {
      const rl = route.config.rateLimit;
      const key = `route:${route.method}:${route.regex}:${request.ip}`;
      const result = this.rateLimiter.check(key, rl.max, rl.timeWindow);

      reply.header("X-RateLimit-Route-Limit", rl.max);
      reply.header("X-RateLimit-Route-Remaining", result.remaining);
      reply.header("X-RateLimit-Route-Reset", Math.ceil(result.resetTime / 1000));

      if (!result.allowed) {
        return reply.status(429).send({
          message: "Too Many Requests",
          error: "Rate limit exceeded",
          statusCode: 429
        });
      }
    }

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

    const timeout = route.config.timeout || this.defaultTimeout;

    if (route.config.stream) {
      return this.handleStream(request, reply, route, event, timeout);
    }

    try {
      const { exitCode, stdout, stderr } = await this.commandPool.execute(
        route.command,
        JSON.stringify(event),
        timeout
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
      if (error instanceof CommandPoolFullError || error instanceof CommandPoolTimeoutError) {
        return reply.status(503).send({
          message: "Service Unavailable",
          error: error.message,
          statusCode: 503
        });
      }
      return reply.status(500).type("text/plain").send(error.message);
    }
  }

  handleStream(request, reply, route, event, timeout) {
    let child;
    try {
      child = this.commandPool.stream(route.command, JSON.stringify(event), timeout);
    } catch (error) {
      if (error instanceof CommandPoolFullError) {
        return reply.status(503).send({
          message: "Service Unavailable",
          error: error.message,
          statusCode: 503
        });
      }
      throw error;
    }

    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });

    const rl = readline.createInterface({ input: child.stdout });

    rl.on("line", line => {
      raw.write(`data: ${line}\n\n`);
    });

    child.on("exit", code => {
      if (code !== 0) {
        raw.write(`event: error\ndata: Command exited with code ${code}\n\n`);
      }
      raw.write("event: done\ndata: stream complete\n\n");
      raw.end();
    });

    request.raw.on("close", () => {
      Command.killProcessGroup(child);
    });

    return reply;
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
