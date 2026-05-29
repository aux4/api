const fastify = require("fastify");
const fs = require("fs");
const path = require("path");

const PID_FILE = ".pid";
const { uuid } = require("./middleware/UuidMiddleware");
const { requestTemporaryFolder } = require("./middleware/RequestTemporaryFolderMiddleware");
const RateLimiter = require("./middleware/RateLimiter");
const { ipAllowlist } = require("./middleware/IpAllowlistMiddleware");
const { CommandPool } = require("./CommandPool");
const RestHandler = require("./handler/RestHandler");
const ViewHandler = require("./handler/ViewHandler");
const WebSocketHandler = require("./handler/WebSocketHandler");
const ComponentLoader = require("./handler/ComponentLoader");

class Server {
  constructor(config) {
    this.config = config;
  }

  async start() {
    if (this.config.production) {
      require("./handler/TemplateRenderer").setProduction(true);
    }

    const fastifyOptions = {
      logger: false,
      disableRequestLogging: true
    };

    if (this.config.server?.trustProxy) {
      fastifyOptions.trustProxy = this.config.server.trustProxy;
    }

    if (this.config.server?.limits?.bodySize) {
      fastifyOptions.bodyLimit = this.config.server.limits.bodySize;
    }

    if (this.config.tls?.key && this.config.tls?.cert) {
      fastifyOptions.https = {
        key: fs.readFileSync(this.config.tls.key),
        cert: fs.readFileSync(this.config.tls.cert)
      };
    }

    const app = fastify(fastifyOptions);

    await app.register(require("@fastify/cors"), this.config.cors || {});
    await app.register(require("@fastify/cookie"));

    // Security headers
    if (this.config.security?.helmet) {
      const helmetOptions = typeof this.config.security.helmet === "object" ? this.config.security.helmet : {};
      await app.register(require("@fastify/helmet"), helmetOptions);
    }

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

    // IP allowlist for non-API routes
    const ipHook = ipAllowlist(this.config.security);
    if (ipHook) {
      app.addHook("onRequest", ipHook);
    }

    // Global rate limiting
    const rateLimiter = new RateLimiter();
    this.rateLimiter = rateLimiter;
    const globalRateLimit = this.config.security?.rateLimit;

    if (globalRateLimit) {
      app.addHook("onRequest", async (request, reply) => {
        const key = `global:${request.ip}`;
        const result = rateLimiter.check(key, globalRateLimit.max, globalRateLimit.timeWindow);

        reply.header("X-RateLimit-Limit", globalRateLimit.max);
        reply.header("X-RateLimit-Remaining", result.remaining);
        reply.header("X-RateLimit-Reset", Math.ceil(result.resetTime / 1000));

        if (!result.allowed) {
          return reply.status(429).send({
            message: "Too Many Requests",
            error: "Rate limit exceeded",
            statusCode: 429
          });
        }
      });
    }

    // Error interceptor
    const { renderErrorTemplate, parseErrorData } = require("./handler/TemplateRenderer");
    const errorRedirects = this.config.security?.errorRedirects || {};
    if (this.config.security?.auth?.redirect && !errorRedirects["401"]) {
      errorRedirects["401"] = this.config.security.auth.redirect;
    }

    app.addHook("onSend", async (request, reply, payload) => {
      if (reply.statusCode < 400 || reply.getHeader("content-type")?.includes("text/html")) {
        return payload;
      }

      const acceptHeader = request.headers.accept || "";
      const prefersJson = acceptHeader.includes("application/json") && !acceptHeader.includes("text/html");

      if (prefersJson && request.url.startsWith("/api/")) {
        const errorData = parseErrorData(payload, reply.statusCode);
        reply.type("application/json");
        return JSON.stringify({ error: { message: errorData.message, status: reply.statusCode } });
      }

      const originalStatus = reply.statusCode;
      const result = renderErrorTemplate(payload, originalStatus, errorRedirects);
      if (result) {
        reply.type("text/html");
        reply.status(result.status);
        if (originalStatus === 401) {
          reply.header("X-Auth-Redirect", "true");
        }
        return result.html;
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

    // Media directory
    const mediaDir = this.config.server?.media;
    if (mediaDir) {
      const mediaPath = path.resolve(mediaDir);
      if (fs.existsSync(mediaPath)) {
        await app.register(require("@fastify/static"), {
          root: mediaPath,
          prefix: "/media/",
          decorateReply: false
        });
      }
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

    // Load components
    const hasComponents = this.config.components && Object.keys(this.config.components).length > 0;
    if (hasComponents) {
      const loader = new ComponentLoader(this.config);
      const { routes, viewMappings } = loader.load();

      // Merge component routes into config
      this.config.api = { ...(this.config.api || {}), ...routes };

      // Register component view mappings
      require("./handler/TemplateRenderer").setComponentViewMappings(viewMappings);

      // Serve aux4-component.js
      const componentJs = `(function() {
  var pending = [];
  var timer = null;

  function processScripts(el) {
    el.querySelectorAll("script").forEach(function(s) {
      var n = document.createElement("script");
      n.textContent = s.textContent;
      s.replaceWith(n);
    });
  }

  function renderComponent(comp, html, headers) {
    if (headers && headers.get("X-Auth-Redirect") === "true") {
      var app = document.getElementById("app");
      if (app) { app.innerHTML = html; processScripts(app); if (typeof htmx !== "undefined") htmx.process(app); }
      return;
    }
    comp.innerHTML = html;
    processScripts(comp);
    if (typeof htmx !== "undefined") htmx.process(comp);
  }

  function flushBatch() {
    var batch = pending.splice(0);
    if (batch.length === 0) return;

    if (batch.length === 1) {
      var item = batch[0];
      fetch(item.url, { headers: { Accept: "text/html" } }).then(function(res) {
        if (res.ok) res.text().then(function(html) { renderComponent(item.comp, html, res.headers); });
      });
      return;
    }

    var urls = batch.map(function(b) { return b.url; });
    fetch("/aux4/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ urls: urls })
    }).then(function(res) {
      if (!res.ok) return;
      return res.json();
    }).then(function(results) {
      if (!results) return;
      for (var i = 0; i < batch.length; i++) {
        if (results[i] && results[i].html) {
          renderComponent(batch[i].comp, results[i].html, null);
        }
      }
    });
  }

  class Aux4Component extends HTMLElement {
    connectedCallback() {
      var src = this.getAttribute("src");
      if (!src) return;
      var params = {};
      for (var j = 0; j < this.attributes.length; j++) {
        var attr = this.attributes[j];
        if (attr.name !== "src" && attr.name !== "route") params[attr.name] = attr.value;
      }
      var query = new URLSearchParams(params).toString();
      var p = src;
      if (this.getAttribute("route") === "true") {
        p = window.location.pathname.startsWith(src) ? window.location.pathname : src;
      }
      var apiPath = p.startsWith("/api/") ? p : "/api" + p;
      var url = query ? apiPath + "?" + query : apiPath;

      if (!this.innerHTML.trim()) {
        this.innerHTML = '<div class="placeholder-glow"><div class="placeholder w-100 rounded" style="height:100px"></div></div>';
      }

      pending.push({ comp: this, url: url });
      if (timer) clearTimeout(timer);
      timer = setTimeout(flushBatch, 10);
    }
  }

  customElements.define("aux4-component", Aux4Component);
})();`;
      app.get("/aux4/component.js", (request, reply) => {
        reply.type("application/javascript").send(componentJs);
      });

      // Batch endpoint for component loading
      app.post("/aux4/batch", async (request, reply) => {
        const { urls } = request.body || {};
        if (!Array.isArray(urls) || urls.length === 0) return reply.status(400).send({ error: "urls required" });
        if (urls.length > 20) return reply.status(400).send({ error: "max 20 urls per batch" });
        if (urls.some(u => typeof u !== "string" || !u.startsWith("/api/"))) return reply.status(400).send({ error: "invalid urls" });

        const results = await Promise.all(urls.map(async (url) => {
          try {
            const res = await app.inject({
              method: "GET",
              url,
              headers: { ...request.headers, "content-type": undefined, "accept": "text/html" },
              cookies: request.cookies
            });
            return { html: res.body, status: res.statusCode };
          } catch (e) {
            return { html: "", status: 500 };
          }
        }));

        return reply.send(results);
      });

      // Auto-inject script tag into HTML pages
      app.addHook("onSend", async (request, reply, payload) => {
        if (typeof payload === "string" && reply.getHeader("content-type")?.includes("text/html") && payload.includes("</body>")) {
          return payload.replace("</body>", '<script src="/aux4/component.js"></script>\n</body>');
        }
        return payload;
      });
    }

    // Command pool
    const commandPool = new CommandPool({
      maxConcurrency: this.config.server?.maxConcurrency,
      maxQueue: this.config.server?.maxQueue
    });

    // Register handlers in order: WebSocket -> Views -> REST -> 404

    // WebSocket
    if (hasWebSocket) {
      const wsHandler = new WebSocketHandler(this.config, commandPool);
      wsHandler.register(app);
    }

    // Views
    const viewHandler = new ViewHandler(this.config);
    if (viewHandler.isViewEnabled) {
      viewHandler.register(app);
    }

    // REST API
    if (this.config.api && Object.keys(this.config.api).length > 0) {
      const restHandler = new RestHandler(this.config, rateLimiter, commandPool);
      restHandler.register(app);
    }

    // 404 fallback — serve index.hbs for GET requests if views are enabled
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method === "GET" && fs.existsSync("./views/index.hbs") && !request.url.startsWith("/api/")) {
        return reply.view("index.hbs");
      }
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
      if (this.rateLimiter) this.rateLimiter.destroy();
      try { fs.unlinkSync(PID_FILE); } catch {}
      await this.server.close();
    };

    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
  }

  async stop() {
    if (!this.server) return;
    if (this.rateLimiter) this.rateLimiter.destroy();
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
