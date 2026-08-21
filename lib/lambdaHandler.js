const Server = require("./Server");

// The full Fastify app, built ONCE and wrapped by @fastify/aws-lambda, then
// cached so a warm Lambda container reuses it across invocations (no per-request
// rebuild — the key difference from `api handle`). Because it is the REAL app,
// every plugin works: REST, @fastify/static (static files), downloads, multipart,
// views. Only the socket-only features (WebSocket, SSE streaming) are out.
let cachedHandler;

async function buildHandler(config) {
  if (!cachedHandler) {
    const app = await new Server({ ...config, _returnApp: true }).start();
    const awsLambdaFastify = require("@fastify/aws-lambda");
    // Decide base64 by Content-Type: text-ish bodies (JSON/HTML/JS/CSS/XML/SVG)
    // pass through as UTF-8 (isBase64Encoded:false); everything else (octet-stream,
    // images, pdf, fonts, video, …) is treated as binary → isBase64Encoded:true so
    // a file download survives API Gateway intact. Pair with the gateway's
    // binaryMediaTypes=["*/*"] so it decodes the base64 back to bytes.
    cachedHandler = awsLambdaFastify(app, {
      // Route on the `{proxy+}` greedy capture, not event.path. For a REST API
      // fronted by an API Gateway custom domain with a base-path mapping (aux4
      // cloud serves each machine at <scope>.<suffix>/<vmname>/…), event.path
      // still carries the base path (`/vmname/api/hello`) — AWS does not strip it —
      // so path-based routing 404s. event.pathParameters.proxy is the capture
      // AFTER both base-path and stage stripping (`api/hello`), identical for the
      // raw execute-api URL and the custom domain. Falls back to event.path when
      // there is no proxy param (e.g. the root resource, or non-API-Gateway events).
      pathParameterUsedAsPath: "proxy",
      enforceBase64: res => {
        const ct = (res.headers["content-type"] || res.headers["Content-Type"] || "").toLowerCase();
        if (!ct) return false;
        return !/^(text\/|application\/(json|javascript|xml|graphql|ld\+json|x-www-form-urlencoded)|image\/svg)/.test(ct);
      }
    });
  }
  return cachedHandler;
}

// AWS Lambda Node runtime entrypoint: `handler(event, context)`. The api image
// sets `_config` (or seeds it) before the runtime imports this module.
exports.handler = async (event, context) => {
  const h = await buildHandler(exports._config || {});
  return h(event, context);
};

// CLI / local: read a single API-Gateway proxy event from stdin, run it through
// the adapter, and print the proxy response to stdout — parity with `api handle`
// for testing, but exercising the full app.
exports.lambdaCommand = async function lambdaCommand(config) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim() || "{}";
  const event = JSON.parse(raw);
  const h = await buildHandler(config);
  const response = await h(event, {});
  process.stdout.write(JSON.stringify(response) + "\n", () => process.exit(0));
};

exports.buildHandler = buildHandler;
