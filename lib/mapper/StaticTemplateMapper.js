const ViewMapper = require("./ViewMapper");

const PATH_REGEX = /^(?!\/api).*$/;

class StaticTemplateMapper extends ViewMapper {
  constructor(app, config) {
    super(app, config);
  }

  build() {
    const processor = (req, res, next) => {
      if (!this.isViewEnabled) {
        next();
        return;
      }

      const path = req.path;
      const pathConfig = this.config[path];
      const view = this.getView(pathConfig, path);

      if (view) {
        res.render(view.name, { layout: view.layout });
      } else {
        next();
      }
    };

    Object.values(this.methods).forEach(method => {
      method(PATH_REGEX, processor);
    });
  }
}

module.exports = StaticTemplateMapper;
