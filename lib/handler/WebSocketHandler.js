const crypto = require("crypto");
const { v7: uuidv7 } = require("uuid");
const Command = require("../Command");
const ConnectionManager = require("./ConnectionManager");
const { buildWsConnectEvent, buildWsDisconnectEvent, buildWsMessageEvent } = require("./EventBuilder");
const { isIpAllowed } = require("../middleware/IpAllowlistMiddleware");
const { jsonFlag } = require("./ArgsBuilder");
const { SessionLimitError } = require("./SessionManager");
const AuthHandler = require("./AuthHandler");

class WebSocketHandler {
  constructor(config, commandPool, sessionManager) {
    this.config = config;
    this.commandPool = commandPool;
    this.sessionManager = sessionManager;
    this.connectionManager = new ConnectionManager();
    this.wsRoutes = {};
    this.defaultTimeout = config.server?.timeout || 30000;
    this.authHandler = new AuthHandler(config, commandPool, this.defaultTimeout);
  }

  compile() {
    const ws = this.config.ws || {};

    for (const [route, routeConfig] of Object.entries(ws)) {
      this.wsRoutes[route] = routeConfig;
    }
  }

  register(app) {
    this.compile();

    for (const [wsPath, routeConfig] of Object.entries(this.wsRoutes)) {
      // Stream route: the whole connection is a single long-lived command
      // session (client frames -> stdin, stdout lines -> frames back) instead
      // of the request/response action-routing below. Reuses the same
      // SessionManager that backs the REST session routes.
      if (routeConfig.stream) {
        this.registerStreamRoute(app, wsPath, routeConfig);
        continue;
      }

      const routes = routeConfig.routes || {};

      app.get(wsPath, { websocket: true }, (socket, request) => {
        const security = this.config.security || {};

        // IP allowlist check
        if (security.allowedIPs) {
          if (!isIpAllowed(request.ip, security.allowedIPs)) {
            socket.close(1008, "IP not allowed");
            return;
          }
        }

        // API key check (header or query param)
        if (security.apiKey) {
          const headerName = (security.header || "X-API-Key").toLowerCase();
          const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
          const provided = request.headers[headerName] || url.searchParams.get("apiKey") || "";
          const expected = security.apiKey;
          const a = Buffer.from(provided);
          const b = Buffer.from(expected);
          if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            socket.close(1008, "Invalid or missing API key");
            return;
          }
        }

        const connectionId = uuidv7();
        this.connectionManager.add(connectionId, socket);

        const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
        const queryStringParameters = {};
        for (const [key, value] of url.searchParams.entries()) {
          queryStringParameters[key] = value;
        }

        // Fire $connect
        if (routes.$connect) {
          const event = buildWsConnectEvent(connectionId, request.headers, queryStringParameters);
          this.commandPool.execute(routes.$connect, JSON.stringify(event), this.defaultTimeout).catch(() => {});
        }

        socket.on("message", async (data) => {
          let body;
          try {
            body = JSON.parse(data.toString());
          } catch {
            body = { message: data.toString() };
          }

          const action = body.action || "$default";
          const command = routes[action] || routes.$default;

          if (!command) return;

          const event = buildWsMessageEvent(connectionId, action, body);

          try {
            const { exitCode, stdout } = await this.commandPool.execute(command, JSON.stringify(event), this.defaultTimeout);
            const output = stdout.trim();

            if (exitCode !== 0 || !output) return;

            let parsed;
            try {
              parsed = JSON.parse(output);
            } catch {
              socket.send(output);
              return;
            }

            if (parsed.statusCode && parsed.body) {
              socket.send(typeof parsed.body === "string" ? parsed.body : JSON.stringify(parsed.body));
            } else {
              socket.send(JSON.stringify(parsed));
            }
          } catch {
            // Command failure - silent
          }
        });

        socket.on("close", () => {
          if (routes.$disconnect) {
            const event = buildWsDisconnectEvent(connectionId);
            this.commandPool.execute(routes.$disconnect, JSON.stringify(event), this.defaultTimeout).catch(() => {});
          }

          this.connectionManager.remove(connectionId);
        });
      });
    }

    // Management API: send message to connection
    app.post("/@connections/:connectionId", async (request, reply) => {
      const { connectionId } = request.params;

      try {
        this.connectionManager.send(connectionId, request.body);
        return reply.status(200).send({ message: "Message sent" });
      } catch (error) {
        return reply.status(410).send({ message: error.message });
      }
    });

    // Management API: disconnect a connection
    app.delete("/@connections/:connectionId", async (request, reply) => {
      const { connectionId } = request.params;

      try {
        this.connectionManager.disconnect(connectionId);
        return reply.status(200).send({ message: "Connection closed" });
      } catch (error) {
        return reply.status(410).send({ message: error.message });
      }
    });
  }
  // Registers a "stream" WS route: on connect, authenticate + spawn the
  // configured command as a session bound to the connecting principal; every
  // client frame (text or binary) becomes a stdin write; every stdout line
  // becomes a text frame back; disconnect tears the session down. Session
  // lifecycle (idle timeout, max duration, per-principal cap, SIGTERM then
  // SIGKILL) is entirely delegated to SessionManager — identical behavior to
  // the REST session routes, just driven by WS frames instead of HTTP calls.
  registerStreamRoute(app, wsPath, routeConfig) {
    app.get(wsPath, { websocket: true }, async (socket, request) => {
      const security = this.config.security || {};

      if (security.allowedIPs || routeConfig.allowedIPs) {
        if (!isIpAllowed(request.ip, routeConfig.allowedIPs || security.allowedIPs)) {
          socket.close(1008, "IP not allowed");
          return;
        }
      }

      if (security.apiKey) {
        const headerName = (security.header || "X-API-Key").toLowerCase();
        const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
        const provided = request.headers[headerName] || url.searchParams.get("apiKey") || "";
        const expected = security.apiKey;
        const a = Buffer.from(provided);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
          socket.close(1008, "Invalid or missing API key");
          return;
        }
      }

      let principal = null;
      if (!routeConfig.public && this.authHandler.enabled) {
        const authResult = await this.authHandler.authenticate(request);
        if (authResult.error) {
          socket.close(1008, authResult.error);
          return;
        }
        principal = authResult.principal;
      }

      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      const queryParams = {};
      for (const [key, value] of url.searchParams.entries()) queryParams[key] = value;

      const args = [jsonFlag("query", queryParams), jsonFlag("headers", request.headers), jsonFlag("principal", principal)]
        .filter(Boolean)
        .join(" ");
      const command = args ? `${routeConfig.command} ${args}` : routeConfig.command;

      let session;
      try {
        session = this.sessionManager.create(command, principal, {
          idleTimeout: routeConfig.idleTimeout,
          maxDuration: routeConfig.maxDuration,
          maxPerPrincipal: routeConfig.maxPerPrincipal
        });
      } catch (error) {
        const reason = error instanceof SessionLimitError ? error.message : "Failed to start session";
        socket.close(1013, reason);
        return;
      }

      this.sessionManager.subscribe(session.id, principal, {
        onLine: line => socket.send(line),
        onExit: () => {
          try {
            socket.close(1000, "Command exited");
          } catch {}
        }
      });

      socket.on("message", data => {
        this.sessionManager.input(session.id, principal, data);
      });

      socket.on("close", () => {
        this.sessionManager.unsubscribe(session.id);
        this.sessionManager.destroy(session.id);
      });
    });
  }
}

module.exports = WebSocketHandler;
