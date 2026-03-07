const { v7: uuidv7 } = require("uuid");
const Command = require("../Command");
const ConnectionManager = require("./ConnectionManager");
const { buildWsConnectEvent, buildWsDisconnectEvent, buildWsMessageEvent } = require("./EventBuilder");

class WebSocketHandler {
  constructor(config) {
    this.config = config;
    this.connectionManager = new ConnectionManager();
    this.wsRoutes = {};
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
      const routes = routeConfig.routes || {};

      app.get(wsPath, { websocket: true }, (socket, request) => {
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
          Command.execute(routes.$connect, JSON.stringify(event)).catch(() => {});
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
            const { exitCode, stdout } = await Command.execute(command, JSON.stringify(event));
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
            Command.execute(routes.$disconnect, JSON.stringify(event)).catch(() => {});
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
}

module.exports = WebSocketHandler;
