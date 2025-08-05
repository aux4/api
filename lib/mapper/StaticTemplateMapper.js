const ViewMapper = require("./ViewMapper");

const PATH_REGEX = /^(?!\/api).*$/;

class StaticTemplateMapper extends ViewMapper {
  constructor(app, config) {
    super(app, config);
  }

  canHandle(request) {
    return this.isViewEnabled && request.method === 'GET' && !request.url.startsWith('/api/');
  }

  async handle(request, reply) {
    if (!this.isViewEnabled) {
      return reply.status(404).send({ message: `Route ${request.method}:${request.url} not found`, error: 'Not Found', statusCode: 404 });
    }

    const path = request.url;
    const pathConfig = this.config[path];
    const view = this.getView(pathConfig, path);

    if (view) {
      return reply.view(view.name, { layout: view.layout });
    } else {
      return reply.status(404).send({ message: `Route ${request.method}:${request.url} not found`, error: 'Not Found', statusCode: 404 });
    }
  }

  build() {
    const processor = async (request, reply) => {
      if (!this.isViewEnabled) {
        return reply.callNotFound();
      }

      const path = request.params.path ? `/${request.params.path}` : '/';
      
      // Skip API routes - let CommandLineMapper handle them
      if (path.startsWith('/api/')) {
        return reply.callNotFound();
      }

      const pathConfig = this.config[path];
      const view = this.getView(pathConfig, path);

      if (view) {
        return reply.view(view.name, { layout: view.layout });
      } else {
        return reply.callNotFound();
      }
    };

    // Only register if views are enabled
    if (this.isViewEnabled) {
      this.methods.GET("/:path*", processor);
    }
  }
}

module.exports = StaticTemplateMapper;
