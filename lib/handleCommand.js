const RestHandler = require("./handler/RestHandler");
const { CommandPool } = require("./CommandPool");
const RateLimiter = require("./middleware/RateLimiter");
const ComponentLoader = require("./handler/ComponentLoader");

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", chunk => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

// One event per invocation. Reads a single API Gateway REST v1 proxy event as JSON on stdin,
// routes it through the same engine as 'api start', and writes the proxy response as JSON to
// stdout. This is the in-process entrypoint the Lambda runtime calls (no HTTP server).
async function handleCommand(config) {
  if (config.production) {
    require("./handler/TemplateRenderer").setProduction(true);
  }

  // Merge component routes exactly like Server.start does, so component-mounted routes resolve.
  if (config.components && Object.keys(config.components).length > 0) {
    const loader = new ComponentLoader(config);
    const { routes } = loader.load();
    config.api = { ...(config.api || {}), ...routes };
  }

  const raw = await readStdin();
  let event;
  try {
    event = JSON.parse(raw);
  } catch (error) {
    process.stderr.write("Error: invalid JSON event on stdin: " + error.message + "\n");
    process.exit(1);
  }

  const rateLimiter = new RateLimiter();
  const commandPool = new CommandPool({
    maxConcurrency: config.server?.maxConcurrency,
    maxQueue: config.server?.maxQueue
  });

  const restHandler = new RestHandler(config, rateLimiter, commandPool);
  restHandler.compile();

  const response = await restHandler.dispatch(event);

  rateLimiter.destroy();

  process.stdout.write(JSON.stringify(response) + "\n");
}

module.exports = { handleCommand };
