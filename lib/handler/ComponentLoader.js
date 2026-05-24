const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

class ComponentLoader {
  constructor(config) {
    this.components = config.components || {};
    this.componentsDir = path.resolve("./components");
  }

  load() {
    const routes = {};
    const viewMappings = {};

    for (const [mountPath, componentConfig] of Object.entries(this.components)) {
      const pkg = componentConfig.package;
      if (!pkg) continue;

      const scope = pkg.split("/")[0];
      const name = pkg.split("/")[1];
      const componentDir = path.join(this.componentsDir, scope, name);

      if (!fs.existsSync(componentDir)) {
        console.error(`Component ${pkg} not found at ${componentDir}. Run 'aux4 api init' to install.`);
        continue;
      }

      // Load component config.yaml
      const configFile = path.join(componentDir, "config.yaml");
      let componentRoutes = {};

      if (fs.existsSync(configFile)) {
        try {
          const content = fs.readFileSync(configFile, "utf-8");
          const parsed = yaml.load(content);
          componentRoutes = (parsed.config ? parsed.config.api : parsed.api) || {};
        } catch (err) {
          console.error(`Failed to load config for component ${pkg}: ${err.message}`);
          continue;
        }
      }

      // Prefix routes with mount path and merge
      for (const [route, routeConfig] of Object.entries(componentRoutes)) {
        const spaceIndex = route.indexOf(" ");
        const method = route.substring(0, spaceIndex);
        const routePath = route.substring(spaceIndex + 1);

        // Prefix the route path
        const prefixedPath = routePath === "/" ? mountPath : mountPath + routePath;
        const prefixedRoute = `${method} ${prefixedPath}`;

        // Prefix redirect paths and store mount path
        const config = { ...routeConfig, _mountPath: mountPath };
        if (config.redirect) {
          config.redirect = config.redirect === "/" ? mountPath : mountPath + config.redirect;
        }

        routes[prefixedRoute] = config;
      }

      // Map component views for partial rendering
      // Match command name → view file by the last word of the command
      const viewsDir = path.join(componentDir, "views");
      if (fs.existsSync(viewsDir)) {
        for (const [route, routeConfig] of Object.entries(componentRoutes)) {
          if (!routeConfig.command) continue;
          const command = routeConfig.command;
          const lastWord = command.split(/\s+/).pop();
          const viewFile = path.join(viewsDir, lastWord + ".p.hbs");
          if (fs.existsSync(viewFile)) {
            viewMappings[command] = viewFile;
          }
        }
      }
    }

    return { routes, viewMappings };
  }
}

module.exports = ComponentLoader;
