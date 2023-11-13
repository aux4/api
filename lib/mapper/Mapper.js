class Mapper {
  constructor(app, config = {}) {
    this.app = app;
    this.config = config;
    this.methods = {
      OPTIONS: (path, callback) => app.options(path, callback),
      HEAD: (path, callback) => app.head(path, callback),
      GET: (path, callback) => app.get(path, callback),
      POST: (path, callback) => app.post(path, callback),
      PUT: (path, callback) => app.put(path, callback),
      DELETE: (path, callback) => app.delete(path, callback)
    };
  }

  build() {}
}

module.exports = Mapper;
