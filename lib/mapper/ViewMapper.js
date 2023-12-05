const fs = require("fs");
const path = require("path");
const Mapper = require("./Mapper");

class ViewMapper extends Mapper {
  constructor(app, config) {
    super(app, config);

    const viewsPath = path.resolve(path.join(".", "views"));
    this.isViewEnabled = fs.existsSync(viewsPath);

    const layoutsPath = path.resolve(path.join(viewsPath, "layouts"));
    this.hasLayout = this.isViewEnabled && fs.existsSync(layoutsPath);
  }

  getView(pathConfig, routePath) {
    if (!this.isViewEnabled) {
      return undefined;
    }

    const layout = this.hasLayout && (pathConfig?.view?.layout || "main");
    const name = pathConfig?.view?.name;

    if (name) {
      return { layout, name };
    }

    if (fs.existsSync(`./views${routePath}.hbs`)) {
      return { layout, name: `${routePath.substring(1)}.hbs` };
    }

    if (fs.existsSync(`./views${routePath}.p.hbs`)) {
      return { layout: false, name: `${routePath.substring(1)}.p.hbs` };
    }

    return undefined;
  }
}

module.exports = ViewMapper;
