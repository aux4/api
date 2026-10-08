const { SessionLimitError } = require("./SessionManager");
const { jsonFlag, escapeShellArg } = require("./ArgsBuilder");
const { isIpAllowed } = require("../middleware/IpAllowlistMiddleware");
const AuthHandler = require("./AuthHandler");

const DEFAULT_HEARTBEAT = 15000;

// Generic "session streaming" REST routes, configured under `config.sessions`.
// Each entry wires up four routes for one base path:
//
//   POST   <path>            create a session, spawn the configured command, return {id}
//   POST   <path>/:id/input  append raw body bytes to the command's stdin
//   POST   <path>/:id/end    close the command's stdin (EOF)
//   GET    <path>/:id/events SSE stream of the command's stdout lines
//
// No whisper (or any other) specific behavior lives here — `command` is
// whatever the route config declares, same as a normal `config.api` route.
class SessionHandler {
  constructor(config, sessionManager, commandPool) {
    this.config = config;
    this.sessionManager = sessionManager;
    this.defaultTimeout = config.server?.timeout || 30000;
    this.authHandler = new AuthHandler(config, commandPool, this.defaultTimeout);
    this.routes = [];
  }

  compile() {
    const sessions = this.config.sessions || {};
    this.routes = Object.entries(sessions).map(([route, routeConfig]) => ({ path: route, config: routeConfig }));
  }

  register(app) {
    this.compile();

    // Single encapsulated child context for ALL session routes: these routes
    // need the RAW request body (binary stdin chunks, e.g. PCM audio), not the
    // app-wide JSON/text parsers registered on `app`. Fastify content-type
    // parsers are encapsulated per-plugin, so overriding it here only affects
    // routes registered within this one plugin instance.
    app.register(async instance => {
      instance.addContentTypeParser("*", { parseAs: "buffer" }, (request, body, done) => done(null, body));

      for (const { path: basePath, config: routeConfig } of this.routes) {
        const apiPath = "/api" + basePath;

        instance.post(apiPath, async (request, reply) => this.createSession(request, reply, routeConfig));
        instance.post(`${apiPath}/:id/input`, async (request, reply) => this.inputSession(request, reply, routeConfig));
        instance.post(`${apiPath}/:id/end`, async (request, reply) => this.endSession(request, reply, routeConfig));
        instance.get(`${apiPath}/:id/events`, async (request, reply) => this.streamSession(request, reply, routeConfig));
      }
    });
  }

  checkIp(request, reply, routeConfig) {
    const security = this.config.security || {};
    const allowedIPs = routeConfig.allowedIPs || security.allowedIPs;
    if (allowedIPs && !isIpAllowed(request.ip, allowedIPs)) {
      reply.status(403).send({ message: "Forbidden", error: "IP not allowed", statusCode: 403 });
      return true;
    }
    return false;
  }

  // Authenticates exactly like a `config.api` route: `public: true` skips it,
  // otherwise it runs through the same AuthHandler (cookie/bearer/apiKey/oauth)
  // configured for the whole app. The resulting principal is what the session
  // gets bound to.
  async authenticate(request, routeConfig) {
    if (routeConfig.public || !this.authHandler.enabled) return { principal: null };
    return this.authHandler.authenticate(request);
  }

  sendAuthError(reply, authResult) {
    const status = authResult.status || 401;
    return reply.status(status).send({ message: status === 403 ? "Forbidden" : "Unauthorized", error: authResult.error, statusCode: status });
  }

  buildArgs(request, routeConfig, principal) {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const queryParams = {};
    for (const [key, value] of url.searchParams.entries()) queryParams[key] = value;

    const parts = [
      jsonFlag("query", queryParams),
      jsonFlag("headers", request.headers),
      jsonFlag("principal", principal),
      this.config._configFile ? `--configFile '${escapeShellArg(this.config._configFile)}'` : null
    ].filter(Boolean);

    return parts.join(" ");
  }

  async createSession(request, reply, routeConfig) {
    if (this.checkIp(request, reply, routeConfig)) return;

    const authResult = await this.authenticate(request, routeConfig);
    if (authResult.error) return this.sendAuthError(reply, authResult);
    const principal = authResult.principal;

    const args = this.buildArgs(request, routeConfig, principal);
    const command = args ? `${routeConfig.command} ${args}` : routeConfig.command;

    try {
      const session = this.sessionManager.create(command, principal, {
        idleTimeout: routeConfig.idleTimeout,
        maxDuration: routeConfig.maxDuration,
        maxPerPrincipal: routeConfig.maxPerPrincipal
      });
      return reply.status(201).send({ id: session.id });
    } catch (error) {
      if (error instanceof SessionLimitError) {
        return reply.status(429).send({ message: "Too Many Requests", error: error.message, statusCode: 429 });
      }
      return reply.status(500).send({ message: "Internal Server Error", error: "Failed to start session", statusCode: 500 });
    }
  }

  async inputSession(request, reply, routeConfig) {
    if (this.checkIp(request, reply, routeConfig)) return;

    const authResult = await this.authenticate(request, routeConfig);
    if (authResult.error) return this.sendAuthError(reply, authResult);

    const { id } = request.params;
    const body = request.body;
    const data = Buffer.isBuffer(body) ? body : body === undefined || body === null ? Buffer.alloc(0) : Buffer.from(String(body));

    const ok = this.sessionManager.input(id, authResult.principal, data);
    if (!ok) {
      return reply.status(404).send({ message: "Not Found", error: "Session not found", statusCode: 404 });
    }

    return reply.status(200).send({ message: "ok" });
  }

  async endSession(request, reply, routeConfig) {
    if (this.checkIp(request, reply, routeConfig)) return;

    const authResult = await this.authenticate(request, routeConfig);
    if (authResult.error) return this.sendAuthError(reply, authResult);

    const { id } = request.params;
    const ok = this.sessionManager.end(id, authResult.principal);
    if (!ok) {
      return reply.status(404).send({ message: "Not Found", error: "Session not found", statusCode: 404 });
    }

    return reply.status(200).send({ message: "ok" });
  }

  async streamSession(request, reply, routeConfig) {
    if (this.checkIp(request, reply, routeConfig)) return;

    const authResult = await this.authenticate(request, routeConfig);
    if (authResult.error) return this.sendAuthError(reply, authResult);

    const { id } = request.params;
    const principal = authResult.principal;

    const session = this.sessionManager.get(id, principal);
    if (!session) {
      return reply.status(404).send({ message: "Not Found", error: "Session not found", statusCode: 404 });
    }

    const raw = reply.raw;
    raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });

    const heartbeatMs = routeConfig.heartbeat || DEFAULT_HEARTBEAT;
    const heartbeat = setInterval(() => {
      raw.write(": heartbeat\n\n");
    }, heartbeatMs);

    let closed = false;
    const teardown = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
    };

    const onLine = line => raw.write(`data: ${line}\n\n`);
    const onExit = code => {
      teardown();
      if (code !== 0 && code !== null) raw.write(`event: error\ndata: Command exited with code ${code}\n\n`);
      raw.write("event: end\ndata: stream complete\n\n");
      raw.end();
      this.sessionManager.remove(id);
    };

    this.sessionManager.subscribe(id, principal, { onLine, onExit });

    request.raw.on("close", () => {
      teardown();
      this.sessionManager.unsubscribe(id);
      this.sessionManager.destroy(id);
    });

    return reply;
  }
}

module.exports = SessionHandler;
