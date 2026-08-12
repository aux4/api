const fs = require("fs");
const readline = require("readline");
const Command = require("../Command");
const { CommandPoolFullError, CommandPoolTimeoutError } = require("../CommandPool");
const { buildRestEvent } = require("./EventBuilder");
const { buildSyntheticRequest, CapturingReply, toProxyResponse } = require("./EventAdapter");
const { computeCorsHeaders } = require("./Cors");
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
      let method = route.substring(0, spaceIndex).toUpperCase();
      const pattern = route.substring(spaceIndex + 1);

      // Wildcard method: "*" is an alias for "ANY" — matches every HTTP method.
      if (method === "*") method = "ANY";

      const paramNames = [];
      let greedy = false;
      // {name}    -> single path segment  ([^/]+)
      // {name...} -> greedy catch-all, matches the rest of the path incl. slashes  (.*)
      const regexStr = pattern.replace(/\{(\w+)(\.\.\.)?\}/g, (_, name, dots) => {
        paramNames.push(name);
        if (dots) {
          greedy = true;
          return "(.*)";
        }
        return "([^/]+)";
      });

      const regex = new RegExp("^" + regexStr + "$");

      this.routes.push({
        method,
        regex,
        paramNames,
        greedy,
        command: routeConfig.command,
        config: routeConfig
      });
    }

    // Matching priority: specific routes must always win over catch-alls,
    // regardless of registration order. Lower score = more specific = tried first.
    // A stable sort preserves the original insertion order among equally-specific
    // routes, so existing single-segment {name} behavior is unchanged.
    this.routes.sort((a, b) => this.specificity(a) - this.specificity(b));
  }

  specificity(route) {
    let score = 0;
    if (route.greedy) score += 2; // greedy catch-all is least specific
    if (route.method === "ANY") score += 1; // wildcard method loses to an exact method
    return score;
  }

  match(method, path) {
    for (const route of this.routes) {
      if (route.method !== "ANY" && route.method !== method) continue;

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

  // Transport-agnostic entrypoint: run a single API Gateway REST v1 proxy event through
  // the routing engine and return an API Gateway proxy response
  // { statusCode, headers, body, isBase64Encoded } — no Fastify HTTP server, no socket.
  //
  // Reuses the exact same handle(request, reply) logic as the Fastify path by feeding it a
  // synthetic request built from the event and a capturing reply shim, then serializing what
  // the shim recorded. Streaming (SSE) and multipart routes require a live socket and are not
  // supported through this path — they are detected and rejected instead of silently breaking.
  // True when `stdout` is a non-empty, well-formed JSON object/array — the
  // signal that a command produced an intentional response body (as opposed to
  // crash noise or empty output). Used to decide whether a non-zero-exit command
  // still has a usable response to deliver.
  static hasJsonResponseBody(stdout) {
    const output = (stdout || "").trim();
    if (!output) return false;
    try {
      const parsed = JSON.parse(output);
      return parsed !== null && typeof parsed === "object";
    } catch {
      return false;
    }
  }

  async dispatch(event) {
    if (this.routes.length === 0) this.compile();

    const request = buildSyntheticRequest(event);
    const reply = new CapturingReply();

    // CORS parity with 'api start' (@fastify/cors). This path never runs Fastify, so config.cors
    // must be honored here. OPTIONS preflight is short-circuited BEFORE dispatch: answer 204 with
    // the full preflight header set and never run the command. Actual responses get the CORS
    // headers merged in after handle(). When config.cors is absent/empty (or the origin is not
    // allowed) computeCorsHeaders returns null and nothing is emitted — no behavior change.
    if (request.method === "OPTIONS") {
      const preflightHeaders = computeCorsHeaders(this.config.cors, request, true);
      if (preflightHeaders) {
        reply.status(204);
        for (const [key, value] of Object.entries(preflightHeaders)) reply.header(key, value);
        return toProxyResponse(reply);
      }
    }

    // CORS headers to attach to whatever actual response this dispatch produces.
    const corsHeaders = computeCorsHeaders(this.config.cors, request, false);
    const respond = () => {
      if (corsHeaders) {
        for (const [key, value] of Object.entries(corsHeaders)) reply.header(key, value);
      }
      return toProxyResponse(reply);
    };

    const contentType = request.headers["content-type"] || "";
    if (contentType.startsWith("multipart/form-data")) {
      reply.status(415).send({
        message: "Unsupported Media Type",
        error: "multipart/form-data is not supported by 'api handle'",
        statusCode: 415
      });
      return respond();
    }

    const apiPath = request.url.replace(/\?.*$/, "").replace(/^\/api/, "") || "/";
    const matched = this.match(request.method, apiPath);
    if (matched && matched.route.config.stream) {
      reply.status(501).send({
        message: "Not Implemented",
        error: "streaming routes are not supported by 'api handle'",
        statusCode: 501
      });
      return respond();
    }

    await this.handle(request, reply);
    return respond();
  }

  register(app) {
    this.compile();

    app.route({
      method: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
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
        // A non-zero exit does not always mean the HTTP request failed: a PROXY
        // route command can emit a complete, valid response on stdout and still
        // exit non-zero (shell / exit-code aggregation quirks, or a trailing
        // non-fatal error in a downstream tool). Surface stderr + the exit code
        // so the condition is diagnosable instead of an opaque 500, then fall
        // through to deliver the response when stdout carries a well-formed JSON
        // body. Only when there is no usable response do we fail with a 500.
        console.error(
          `Command exited with code ${exitCode} for ${request.method} ${request.url}: ${stderr ? stderr.trim() : "(no stderr)"}`
        );
        if (!RestHandler.hasJsonResponseBody(stdout)) {
          return reply.status(500).send({ message: "Internal Server Error", error: "Command failed", statusCode: 500 });
        }
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
