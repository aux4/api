const fastify = require("fastify");
const fs = require("fs");
const path = require("path");

const PID_FILE = ".pid";
const { uuid } = require("./middleware/UuidMiddleware");
const { requestTemporaryFolder } = require("./middleware/RequestTemporaryFolderMiddleware");
const RestHandler = require("./handler/RestHandler");
const ViewHandler = require("./handler/ViewHandler");
const WebSocketHandler = require("./handler/WebSocketHandler");

class Server {
  constructor(config) {
    this.config = config;
  }

  async start() {
    const fastifyOptions = {
      logger: false,
      disableRequestLogging: true
    };

    if (this.config.tls?.key && this.config.tls?.cert) {
      fastifyOptions.https = {
        key: fs.readFileSync(this.config.tls.key),
        cert: fs.readFileSync(this.config.tls.cert)
      };
    }

    const app = fastify(fastifyOptions);

    await app.register(require("@fastify/cors"), this.config.cors || {});

    // Register multipart plugin with configurable limits
    const defaultLimits = {
      fieldSize: 1024 * 1024,
      fileSize: 10 * 1024 * 1024,
      files: 5,
      parts: 10
    };

    const serverLimits = this.config.server?.limits || {};
    const multipartLimits = { ...defaultLimits, ...serverLimits };

    await app.register(require("@fastify/multipart"), {
      limits: {
        fieldSize: multipartLimits.fieldSize,
        fileSize: multipartLimits.fileSize,
        parts: multipartLimits.parts
      }
    });

    app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (req, body, done) => {
      const parsed = {};
      const params = new URLSearchParams(body);
      for (const [key, value] of params.entries()) parsed[key] = value;
      done(null, parsed);
    });

    // Register WebSocket plugin if ws config is provided
    const hasWebSocket = this.config.ws && Object.keys(this.config.ws).length > 0;
    if (hasWebSocket) {
      await app.register(require("@fastify/websocket"));
    }

    app.addHook("onRequest", uuid());
    app.addHook("onRequest", requestTemporaryFolder());

    // Error interceptor
    app.addHook("onSend", async (request, reply, payload) => {
      const acceptHeader = request.headers.accept || "";
      const prefersJson = acceptHeader.includes("application/json") && !acceptHeader.includes("text/html");
      const isApiRoute = request.url.startsWith("/api/");

      if (reply.statusCode >= 400 && !reply.getHeader("content-type")?.includes("text/html")) {
        if (prefersJson && isApiRoute) {
          let errorMessage = "An error occurred";

          try {
            const parsed = JSON.parse(payload);
            errorMessage = parsed.message || parsed.error || errorMessage;
          } catch {
            errorMessage = payload || errorMessage;
          }

          const formattedError = {
            error: {
              message: errorMessage,
              status: reply.statusCode
            }
          };

          reply.type("application/json");
          return JSON.stringify(formattedError);
        }

        if (fs.existsSync("./views/error.p.hbs")) {
          let errorData;

          try {
            const parsed = JSON.parse(payload);
            errorData = {
              message: parsed.message || parsed.error || "An error occurred",
              error: parsed.error || "Error",
              statusCode: reply.statusCode
            };
          } catch {
            errorData = {
              message: payload || "An error occurred",
              error: "Error",
              statusCode: reply.statusCode
            };
          }

          const originalStatus = reply.statusCode;
          reply.type("text/html");
          reply.status(originalStatus);

          const handlebars = require("handlebars");
          const errorTemplate = fs.readFileSync("./views/error.p.hbs", "utf-8");
          const compiledTemplate = handlebars.compile(errorTemplate);
          return compiledTemplate(errorData);
        }
      }

      return payload;
    });

    // Static files
    const staticPath = path.resolve(path.join(".", "static"));
    if (fs.existsSync(staticPath)) {
      await app.register(require("@fastify/static"), {
        root: staticPath,
        prefix: "/static/"
      });
    }

    // Handlebars views setup
    if (fs.existsSync("./views")) {
      const handlebars = require("handlebars");

      const partialsPath = path.resolve("./views/partials");
      if (fs.existsSync(partialsPath)) {
        const partialFiles = fs.readdirSync(partialsPath);
        partialFiles.forEach(file => {
          if (file.endsWith(".hbs")) {
            const partialName = file.replace(".hbs", "");
            const partialContent = fs.readFileSync(path.join(partialsPath, file), "utf-8");
            handlebars.registerPartial(partialName, partialContent);
          }
        });
      }

      await app.register(require("@fastify/view"), {
        engine: { handlebars },
        root: path.resolve("./views"),
        layout: "./layouts/main.hbs"
      });

      if (fs.existsSync("./views/i18n")) {
        const HandlebarsI18n = require("handlebars-i18n");
        const i18next = require("i18next");

        i18next.init({
          lng: "en",
          resources: {
            en: {
              translation: {
                hello: "Hello"
              }
            }
          }
        });

        HandlebarsI18n.init();
      }
    }

    // Register handlers in order: WebSocket -> Views -> REST -> 404

    // WebSocket
    if (hasWebSocket) {
      const wsHandler = new WebSocketHandler(this.config);
      wsHandler.register(app);
    }

    // Views
    const viewHandler = new ViewHandler(this.config);
    if (viewHandler.isViewEnabled) {
      viewHandler.register(app);
    }

    // REST API
    if (this.config.api && Object.keys(this.config.api).length > 0) {
      const restHandler = new RestHandler(this.config);
      restHandler.register(app);
    }

    // 404 fallback
    app.setNotFoundHandler(async (request, reply) => {
      return reply.status(404).send({
        message: `Route ${request.method}:${request.url} not found`,
        error: "Not Found",
        statusCode: 404
      });
    });

    const port = this.config.port || 8080;

    try {
      await app.listen({ port, host: "0.0.0.0" });
      fs.writeFileSync(PID_FILE, String(process.pid));
      const protocol = this.config.tls?.key ? "https" : "http";
      console.log(`aux4 api started on ${protocol}://0.0.0.0:${port}`);
      this.server = app;
    } catch (err) {
      console.error("Error starting server:", err);
      throw err;
    }

    const cleanup = async () => {
      if (!this.server) return;
      try { fs.unlinkSync(PID_FILE); } catch {}
      await this.server.close();
    };

    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
  }

  async stop() {
    if (!this.server) return;
    try { fs.unlinkSync(PID_FILE); } catch {}
    await this.server.close();
  }

  static stopByPid() {
    if (!fs.existsSync(PID_FILE)) {
      return;
    }

    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    fs.unlinkSync(PID_FILE);

    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }
}

module.exports = Server;
