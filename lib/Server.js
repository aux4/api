const express = require("express");
const cors = require("cors");
const responseTime = require("response-time");
const fs = require("fs");
const path = require("path");
const { uuid } = require("./middleware/UuidMiddleware");
const { requestTemporaryFolder } = require("./middleware/RequestTemporaryFolderMiddleware");
const { fileUpload } = require("./middleware/FileUploadMiddleware");
const CommandLineMapper = require("./mapper/CommandLineMapper");
const StaticTemplateMapper = require("./mapper/StaticTemplateMapper");

class Server {
  constructor(config) {
    this.config = config;
    this.mappers = [StaticTemplateMapper, CommandLineMapper];
  }

  async start() {
    const app = express();
    app.use(responseTime());
    app.use(cors(this.config.cors || {}));
    app.use(express.json());
    app.use(uuid());
    app.use(requestTemporaryFolder());
    app.use(fileUpload());

    const staticPath = path.resolve(path.join(".", "static"));

    if (fs.existsSync(staticPath)) {
      app.use("/static", express.static(path.resolve(staticPath)));

      const faviconPath = path.resolve(path.join(staticPath, "favicon.ico"));
      if (fs.existsSync(faviconPath)) {
        const favicon = require("serve-favicon");
        app.use(favicon(faviconPath));
      }
    }

    if (fs.existsSync("./views")) {
      const { engine } = require("express-handlebars");
      app.engine(".hbs", engine({ extname: ".hbs" }));
      app.engine(".p.hbs", engine({ extname: ".p.hbs" }));
      app.set("views", path.resolve("./views"));

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

    this.mappers.forEach(Mapper => {
      const mapper = new Mapper(app, this.config);
      mapper.build();
    });

    const port = this.config.port || 8080;

    this.server = app.listen(port, () => {
      console.log(`aux4 api started on port ${port}`);
    });

    process.on("SIGTERM", () => {
      if (!this.server) return;

      this.server.close();
    });
  }

  stop() {
    if (!this.server) return;

    this.server.close();
  }
}

module.exports = Server;
