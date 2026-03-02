const fs = require("fs");
const path = require("path");

const SKIP_DIRS = new Set(["layouts", "partials", "i18n"]);
const SKIP_FILES = new Set(["error.p.hbs"]);

class ViewHandler {
  constructor(config) {
    this.config = config;
    this.routes = [];

    const viewsPath = path.resolve("./views");
    this.isViewEnabled = fs.existsSync(viewsPath);

    const layoutsPath = path.join(viewsPath, "layouts");
    this.hasLayout = this.isViewEnabled && fs.existsSync(layoutsPath);
  }

  scan() {
    if (!this.isViewEnabled) return;

    const viewsPath = path.resolve("./views");
    this.scanDirectory(viewsPath, "");
  }

  scanDirectory(dirPath, prefix) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        this.scanDirectory(path.join(dirPath, entry.name), prefix + "/" + entry.name);
      } else if (entry.name.endsWith(".hbs")) {
        if (SKIP_FILES.has(entry.name)) continue;

        const isPartial = entry.name.endsWith(".p.hbs");
        const baseName = isPartial
          ? entry.name.slice(0, -6)
          : entry.name.slice(0, -4);

        let routePath;
        if (baseName === "index" && prefix === "") {
          routePath = "/";
        } else {
          routePath = prefix + "/" + baseName;
        }

        // Convert {id} segments to :id params
        const paramNames = [];
        const fastifyPath = routePath.replace(/\{(\w+)\}/g, (_, name) => {
          paramNames.push(name);
          return ":" + name;
        });

        const relativeName = (prefix ? prefix.substring(1) + "/" : "") + entry.name;

        this.routes.push({
          fastifyPath,
          paramNames,
          viewName: relativeName,
          layout: isPartial ? false : (this.hasLayout && "./layouts/main.hbs")
        });
      }
    }
  }

  register(app) {
    this.scan();

    for (const route of this.routes) {
      app.get(route.fastifyPath, async (request, reply) => {
        const context = {};

        if (route.layout === false) {
          context.layout = false;
        }

        for (const name of route.paramNames) {
          context[name] = request.params[name];
        }

        return reply.view(route.viewName, context);
      });
    }
  }
}

module.exports = ViewHandler;
