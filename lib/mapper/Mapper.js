class Mapper {
  constructor(app, config = {}) {
    this.app = app;
    this.config = config;
    this.methods = {
      OPTIONS: (path, callback) => app.route({ method: 'OPTIONS', url: path, handler: callback }),
      HEAD: (path, callback) => app.route({ method: 'HEAD', url: path, handler: callback }),
      GET: (path, callback) => app.route({ method: 'GET', url: path, handler: callback }),
      POST: (path, callback) => app.route({ method: 'POST', url: path, handler: callback }),
      PUT: (path, callback) => app.route({ method: 'PUT', url: path, handler: callback }),
      DELETE: (path, callback) => app.route({ method: 'DELETE', url: path, handler: callback })
    };
  }

  build() {}
}

module.exports = Mapper;
