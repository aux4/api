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

        // Prefix redirect paths
        const config = { ...routeConfig };
        if (config.redirect) {
          config.redirect = config.redirect === "/" ? mountPath : mountPath + config.redirect;
        }

        routes[prefixedRoute] = config;
      }

      // Map component views for partial rendering
      const viewsDir = path.join(componentDir, "views");
      if (fs.existsSync(viewsDir)) {
        // Map command name → component view path
        // e.g., "aux4 contacts list" → "components/aux4/contacts/views/list.p.hbs"
        const files = fs.readdirSync(viewsDir);
        for (const file of files) {
          if (file.endsWith(".p.hbs")) {
            const commandSuffix = file.slice(0, -6); // remove .p.hbs
            const commandName = `aux4 ${name} ${commandSuffix}`;
            viewMappings[commandName] = path.join(componentDir, "views", file);
          }
        }
      }
    }

    return { routes, viewMappings };
  }
}

module.exports = ComponentLoader;
