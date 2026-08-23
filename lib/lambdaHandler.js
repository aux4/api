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

// Long-lived cloud runtime: build the Fastify app ONCE, then own the AWS Lambda
// runtime API loop so the warm app is reused across invocations. This replaces the
// old model (a fresh `api lambda` process per invocation, rebuilding Fastify every
// call ≈ 1s). It's pure Node — no aux4 nested-daemon — so it sidesteps that
// deadlock. An optional post-invocation hook (AUX4_LAMBDA_POST_INVOKE, a shell
// command) runs AFTER the response is posted, so stateful machines can still sync
// state to S3 without adding latency to the response path.
exports.lambdaLoop = async function lambdaLoop(config) {
  const api = process.env.AWS_LAMBDA_RUNTIME_API;
  if (!api) {
    console.error("lambda-loop: AWS_LAMBDA_RUNTIME_API is not set");
    process.exit(1);
  }
  const base = `http://${api}/2018-06-01/runtime`;
  const postInvoke = process.env.AUX4_LAMBDA_POST_INVOKE;
  const { execSync } = require("child_process");

  // This is a long-lived server, so it owns a warm aux4 command daemon (same as
  // `api start`): command-backed routes and their nested `aux4` calls reuse it
  // instead of cold-starting the CLI per request. Best-effort; the container's
  // death cleans it up (Lambda freezes/kills rather than stopping gracefully).
  const CommandDaemon = require("./CommandDaemon");
  CommandDaemon.start();
  process.on("SIGTERM", () => CommandDaemon.stop());
  process.on("SIGINT", () => CommandDaemon.stop());

  const errBody = err => JSON.stringify({
    errorMessage: String((err && err.message) || err),
    errorType: (err && err.name) || "Error"
  });

  let h;
  try {
    h = await buildHandler(config); // built ONCE — reused warm for every invocation
  } catch (err) {
    await fetch(`${base}/init/error`, { method: "POST", body: errBody(err) }).catch(() => {});
    console.error("lambda-loop: init failed:", err);
    process.exit(1);
  }

  for (;;) {
    let requestId;
    try {
      const next = await fetch(`${base}/invocation/next`); // long-poll: blocks until an invocation
      requestId = next.headers.get("lambda-runtime-aws-request-id");
      const event = await next.json();

      let response;
      try {
        response = await h(event, {});
      } catch (err) {
        await fetch(`${base}/invocation/${requestId}/error`, { method: "POST", body: errBody(err) }).catch(() => {});
        continue;
      }

      await fetch(`${base}/invocation/${requestId}/response`, { method: "POST", body: JSON.stringify(response) });

      if (postInvoke) {
        try { execSync(postInvoke, { stdio: "ignore" }); }
        catch (e) { console.error("lambda-loop: post-invoke hook failed:", e.message); }
      }
    } catch (err) {
      // Transient runtime-API error: log and keep the warm process alive.
      console.error("lambda-loop: iteration error:", (err && err.message) || err);
    }
  }
};

exports.buildHandler = buildHandler;
