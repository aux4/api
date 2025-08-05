const fastify = require("fastify");
const fs = require("fs");
const path = require("path");
const { uuid } = require("./middleware/UuidMiddleware");
const { requestTemporaryFolder } = require("./middleware/RequestTemporaryFolderMiddleware");
const CommandLineMapper = require("./mapper/CommandLineMapper");
const StaticTemplateMapper = require("./mapper/StaticTemplateMapper");

class Server {
  constructor(config) {
    this.config = config;
    this.mappers = [CommandLineMapper, StaticTemplateMapper];
  }

  async start() {
    const app = fastify({ 
      logger: false,
      disableRequestLogging: true
    });
    
    await app.register(require('@fastify/cors'), this.config.cors || {});
    
    // Register multipart plugin with configurable limits
    const defaultLimits = {
      fieldSize: 1024 * 1024,     // 1MB field size
      fileSize: 10 * 1024 * 1024, // 10MB file size  
      files: 5,                   // Max 5 files
      parts: 10                   // Max 10 parts
    };
    
    const serverLimits = this.config.server?.limits || {};
    const multipartLimits = { ...defaultLimits, ...serverLimits };
    
    console.log('Multipart limits configuration:', multipartLimits);
    
    await app.register(require('@fastify/multipart'), {
      limits: {
        fieldSize: multipartLimits.fieldSize,
        fileSize: multipartLimits.fileSize,
        parts: multipartLimits.parts
      }
    });
    
    
    app.addHook('onRequest', uuid());
    app.addHook('onRequest', requestTemporaryFolder());
    
    // Error interceptor - check for error.p.hbs template for all error responses
    app.addHook('onSend', async (request, reply, payload) => {
      // Only intercept error responses (4xx, 5xx) that aren't already rendered views
      if (reply.statusCode >= 400 && !reply.getHeader('content-type')?.includes('text/html')) {
        if (fs.existsSync('./views/error.p.hbs')) {
          let errorData;
          
          try {
            // Try to parse JSON payload to extract error information
            const parsed = JSON.parse(payload);
            errorData = {
              message: parsed.message || parsed.error || 'An error occurred',
              error: parsed.error || 'Error',
              statusCode: reply.statusCode
            };
          } catch {
            // If not JSON, create default error data
            errorData = {
              message: payload || 'An error occurred',
              error: 'Error',
              statusCode: reply.statusCode
            };
          }
          
          // Preserve the original error status code
          const originalStatus = reply.statusCode;
          
          // Set HTMX-friendly headers for error handling
          reply.type('text/html');
          reply.status(originalStatus); // Ensure status is preserved after setting content-type
          
          // Render the error template directly without layout
          const handlebars = require('handlebars');
          const errorTemplate = fs.readFileSync('./views/error.p.hbs', 'utf-8');
          const compiledTemplate = handlebars.compile(errorTemplate);
          return compiledTemplate(errorData);
        }
      }
      
      return payload;
    });

    const staticPath = path.resolve(path.join(".", "static"));

    if (fs.existsSync(staticPath)) {
      await app.register(require('@fastify/static'), {
        root: path.resolve(staticPath),
        prefix: '/static/'
      });
    }

    if (fs.existsSync("./views")) {
      const handlebars = require('handlebars');
      
      // Register partials
      const partialsPath = path.resolve('./views/partials');
      if (fs.existsSync(partialsPath)) {
        const partialFiles = fs.readdirSync(partialsPath);
        partialFiles.forEach(file => {
          if (file.endsWith('.hbs')) {
            const partialName = file.replace('.hbs', '');
            const partialContent = fs.readFileSync(path.join(partialsPath, file), 'utf-8');
            handlebars.registerPartial(partialName, partialContent);
          }
        });
      }
      
      await app.register(require('@fastify/view'), {
        engine: {
          handlebars: handlebars
        },
        root: path.resolve('./views'),
        layout: './layouts/main.hbs'
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

    // Create mapper instances
    const mapperInstances = this.mappers.map(Mapper => new Mapper(app, this.config));
    const staticTemplateMapper = mapperInstances.find(m => m.constructor.name === 'StaticTemplateMapper');
    const commandLineMapper = mapperInstances.find(m => m.constructor.name === 'CommandLineMapper');
    
    // Register API routes using parameter pattern
    if (commandLineMapper) {
      const apiHandler = async (request, reply) => {
        return await commandLineMapper.handle(request, reply);
      };
      
      
      // Register for all HTTP methods using parameter pattern
      app.route({
        method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        url: '/api/*',
        handler: apiHandler,
      });
      
    }
    
    // Register root route
    app.get('/', async (request, reply) => {
      try {
        if (staticTemplateMapper && staticTemplateMapper.isViewEnabled) {
          const path = request.url;
          const pathConfig = staticTemplateMapper.config[path];
          const view = staticTemplateMapper.getView(pathConfig, path);
          
          if (view) {
            return reply.view(view.name, { layout: view.layout });
          }
        }
        // Return 404 if no view is found, just like Express version
        return reply.status(404).send({ message: `Route ${request.method}:${request.url} not found`, error: 'Not Found', statusCode: 404 });
      } catch (error) {
        return reply.status(500).send({ error: error.message });
      }
    });
    
    // Register wildcard for other paths
    app.get('*', async (request, reply) => {
      try {
        if (request.url.startsWith('/api/')) {
          return reply.callNotFound();
        }
        
        if (staticTemplateMapper && staticTemplateMapper.isViewEnabled) {
          const path = request.url;
          const pathConfig = staticTemplateMapper.config[path];
          const view = staticTemplateMapper.getView(pathConfig, path);
          
          if (view) {
            return reply.view(view.name, { layout: view.layout });
          }
        }
        
        return reply.status(404).send({ message: `Route ${request.method}:${request.url} not found`, error: 'Not Found', statusCode: 404 });
      } catch (error) {
        return reply.status(500).send({ error: error.message });
      }
    });

    const port = this.config.port || 8080;

    try {
      await app.listen({ port, host: '0.0.0.0' });
      console.log(`aux4 api started on port ${port}`);
      this.server = app;
    } catch (err) {
      console.error('Error starting server:', err);
      throw err;
    }

    process.on("SIGTERM", async () => {
      if (!this.server) return;

      await this.server.close();
    });
  }

  async stop() {
    if (!this.server) return;

    await this.server.close();
  }
}

module.exports = Server;
