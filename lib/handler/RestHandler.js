const fs = require("fs");
const readline = require("readline");
const Command = require("../Command");
const { CommandPoolFullError, CommandPoolTimeoutError } = require("../CommandPool");
const { buildRestEvent } = require("./EventBuilder");
const { isIpAllowed } = require("../middleware/IpAllowlistMiddleware");
const AuthHandler = require("./AuthHandler");
const CookieHandler = require("./CookieHandler");
const { hasViews, prefersJson, renderCommandPartial, renderViewPartial } = require("./TemplateRenderer");

function escapeShellArg(str) {
  return str.replace(/[\r\n]/g, " ").replace(/'/g, "'\\''");
}

class RestHandler {
  constructor(config, rateLimiter, commandPool) {
    this.config = config;
    this.rateLimiter = rateLimiter;
    this.commandPool = commandPool;
    this.routes = [];
    this.fileLimit = config.server?.limits?.files || 5;
    this.defaultTimeout = config.server?.timeout || 30000;
    this.production = !!config.production;
    this.authHandler = new AuthHandler(config, commandPool, this.defaultTimeout);
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

    // IP allowlist
    const allowedIPs = route.config.allowedIPs || security.allowedIPs;
    if (allowedIPs && !isIpAllowed(request.ip, allowedIPs)) {
      return reply.status(403).send({ message: "Forbidden", error: "IP not allowed", statusCode: 403 });
    }

    // Rate limiting
    if (route.config.rateLimit && this.rateLimiter) {
      const denied = this.checkRateLimit(reply, route);
      if (denied) return denied;
    }

    // Authentication
    let principal = null;
    if (this.authHandler.enabled && !route.config.public) {
      const authResult = await this.authHandler.authenticate(request);
      if (authResult.error) {
        return reply.status(401).send({ message: "Unauthorized", error: authResult.error, statusCode: 401 });
      }
      principal = authResult.principal;
    }

    // Parse body
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

    // No command — handle cookie/redirect only
    if (!route.command) {
      CookieHandler.clearCookie(reply, route.config.clearCookie);
      if (route.config.redirect) {
        return this.handleRedirect(request, reply, route.config.redirect, principal);
      }
      return reply.status(200).send("{}");
    }

    // Execute command
    const args = this.buildArgs(request, pathParameters, event, principal);
    const command = args ? `${route.command} ${args}` : route.command;
    const timeout = route.config.timeout || this.defaultTimeout;

    if (route.config.stream) {
      return this.handleStream(request, reply, command, timeout);
    }

    try {
      const { exitCode, stdout, stderr } = await this.commandPool.execute(command, JSON.stringify(event), timeout);

      if (exitCode !== 0) {
        return reply.status(500).send({ message: "Internal Server Error", error: "Command failed", statusCode: 500 });
      }

      // Post-command actions
      CookieHandler.clearCookie(reply, route.config.clearCookie);
      CookieHandler.setCookie(reply, route.config.setCookie, stdout.trim(), this.production);

      // Redirect
      if (route.config.redirect) {
        let redirectPrincipal = principal;
        if (!redirectPrincipal && route.config.setCookie) {
          const cookieValue = CookieHandler.extractCookieValue(stdout.trim(), route.config.setCookie);
          if (cookieValue) {
            redirectPrincipal = await this.authHandler.authenticateWithCookie(
              request, route.config.setCookie.name || "token", cookieValue
            );
          }
        }
        return this.handleRedirect(request, reply, route.config.redirect, redirectPrincipal);
      }

      return this.sendResponse(request, reply, stdout.trim(), route);
    } catch (error) {
      if (error instanceof CommandPoolFullError || error instanceof CommandPoolTimeoutError) {
        return reply.status(503).send({ message: "Service Unavailable", error: error.message, statusCode: 503 });
      }
      return reply.status(500).send({ message: "Internal Server Error", error: "Unexpected error", statusCode: 500 });
    }
  }

  getComponentPaths(route) {
    const mountPath = route.config._mountPath;
    if (mountPath) {
      return { apiPath: "/api" + mountPath, basePath: mountPath };
    }
    // Fallback for non-component routes
    const urlPath = route.regex.source.replace(/\^|\$|\(\[\^\/\]\+\)/g, "").replace(/\\/g, "");
    const base = urlPath.replace(/\/[^/]*$/, "") || urlPath;
    return { apiPath: "/api" + base, basePath: base || "/" };
  }

  sendResponse(request, reply, output, route) {
    const command = route.command;
    // Data URI
    if (output.startsWith("data:")) {
      return this.sendDataUri(reply, output);
    }

    // Parse JSON
    let response;
    try {
      response = JSON.parse(output);
    } catch {
      return reply.status(200).type("text/plain").send(output);
    }

    // AWS API Gateway format
    if (response.statusCode) {
      const headers = response.headers || {};
      for (const [key, value] of Object.entries(headers)) {
        reply.header(key, value);
      }
      if (response.isBase64Encoded) {
        return reply.status(response.statusCode).send(Buffer.from(response.body || "", "base64"));
      }
      return reply.status(response.statusCode).send(response.body || "");
    }

    // Render partial if views exist and client doesn't prefer JSON
    if (request.method === "GET" && !prefersJson(request) && hasViews()) {
      const { apiPath, basePath } = this.getComponentPaths(route);
      const queryExtra = {};
      const qIndex = request.url.indexOf("?");
      if (qIndex !== -1) {
        const params = new URLSearchParams(request.url.substring(qIndex + 1));
        for (const [key, value] of params.entries()) queryExtra[key] = value;
      }
      const html = renderCommandPartial(command, response, apiPath, basePath, queryExtra);
      if (html) return reply.type("text/html").send(html);
    }

    return reply.status(200).type("application/json").send(JSON.stringify(response));
  }

  sendDataUri(reply, output) {
    const commaIndex = output.indexOf(",");
    if (commaIndex === -1) return reply.status(200).type("text/plain").send(output);

    const meta = output.substring(5, commaIndex);
    const base64Data = output.substring(commaIndex + 1);
    const parts = meta.split(";");

    reply.type(parts[0]);
    for (const part of parts) {
      if (part.startsWith("filename=")) {
        const disposition = parts.includes("inline") ? "inline" : "attachment";
        reply.header("Content-Disposition", `${disposition}; filename="${part.substring(9)}"`);
      }
    }

    return reply.status(200).send(Buffer.from(base64Data, "base64"));
  }

  async handleRedirect(request, reply, redirectPath, principal) {
    // Try API route
    const redirectResult = this.match("GET", redirectPath);
    if (redirectResult) {
      const redirectArgs = this.buildArgs(request, redirectResult.pathParameters, buildRestEvent(request, redirectResult.pathParameters), principal);
      const redirectCommand = redirectArgs ? `${redirectResult.route.command} ${redirectArgs}` : redirectResult.route.command;
      const { exitCode, stdout } = await this.commandPool.execute(redirectCommand, null, this.defaultTimeout);

      if (exitCode === 0) {
        const output = stdout.trim();
        try {
          const response = JSON.parse(output);
          if (!prefersJson(request) && hasViews()) {
            const { apiPath, basePath } = this.getComponentPaths(redirectResult.route);
            const queryExtra = {};
            const qIndex = request.url.indexOf("?");
            if (qIndex !== -1) {
              const params = new URLSearchParams(request.url.substring(qIndex + 1));
              for (const [key, value] of params.entries()) queryExtra[key] = value;
            }
            const html = renderCommandPartial(redirectResult.route.command, response, apiPath, basePath, queryExtra);
            if (html) return reply.type("text/html").send(html);
          }
          return reply.status(200).type("application/json").send(JSON.stringify(response));
        } catch {
          return reply.status(200).type("text/plain").send(output);
        }
      }
    }

    // Try view partial
    const html = renderViewPartial(redirectPath);
    if (html) return reply.type("text/html").send(html);

    return reply.status(200).send("{}");
  }

  checkRateLimit(reply, route) {
    const rl = route.config.rateLimit;
    const key = `route:${route.method}:${route.regex}:`;
    const result = this.rateLimiter.check(key, rl.max, rl.timeWindow);

    reply.header("X-RateLimit-Route-Limit", rl.max);
    reply.header("X-RateLimit-Route-Remaining", result.remaining);
    reply.header("X-RateLimit-Route-Reset", Math.ceil(result.resetTime / 1000));

    if (!result.allowed) {
      return reply.status(429).send({ message: "Too Many Requests", error: "Rate limit exceeded", statusCode: 429 });
    }
    return null;
  }

  handleStream(request, reply, command, timeout) {
    let child;
    try {
      child = this.commandPool.stream(command, null, timeout);
    } catch (error) {
      if (error instanceof CommandPoolFullError) {
        return reply.status(503).send({ message: "Service Unavailable", error: error.message, statusCode: 503 });
      }
      throw error;
    }

    const raw = reply.raw;
    raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", line => { raw.write(`data: ${line}\n\n`); });

    child.on("exit", code => {
      if (code !== 0) raw.write(`event: error\ndata: Command exited with code ${code}\n\n`);
      raw.write("event: done\ndata: stream complete\n\n");
      raw.end();
    });

    request.raw.on("close", () => { Command.killProcessGroup(child); });
    return reply;
  }

  buildArgs(request, pathParameters, event, principal) {
    const args = [];

    if (pathParameters && Object.keys(pathParameters).length > 0) {
      args.push("--params", `'${escapeShellArg(JSON.stringify(pathParameters))}'`);
    }

    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const queryParams = {};
    for (const [key, value] of url.searchParams.entries()) queryParams[key] = value;
    if (Object.keys(queryParams).length > 0) {
      args.push("--query", `'${escapeShellArg(JSON.stringify(queryParams))}'`);
    }

    if (request.headers && Object.keys(request.headers).length > 0) {
      args.push("--headers", `'${escapeShellArg(JSON.stringify(request.headers))}'`);
    }

    if (request.cookies && Object.keys(request.cookies).length > 0) {
      args.push("--cookies", `'${escapeShellArg(JSON.stringify(request.cookies))}'`);
    }

    if (principal) {
      args.push("--principal", `'${escapeShellArg(JSON.stringify(principal))}'`);
    }

    if (event.body) {
      args.push("--body", `'${escapeShellArg(event.body)}'`);
    }

    return args.join(" ");
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
            reply.status(413).send({ message: `Too many files. Maximum: ${this.fileLimit}`, error: "Payload Too Large", statusCode: 413 });
            return body;
          }

          const buffer = await part.toBuffer();
          const filePath = `${request.tmpDir}/${part.filename}`;
          fs.writeFileSync(filePath, buffer);

          body[part.fieldname] = body[part.fieldname] || [];
          body[part.fieldname].push({
            filename: part.filename,
            encoding: part.encoding,
            mimeType: part.mimetype,
            path: filePath
          });
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
