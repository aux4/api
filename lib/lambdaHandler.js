const Server = require("./Server");
const fs = require("fs");
const yaml = require("js-yaml");

// When routes are supplied via --configFile, the `config.api` map arrives in the
// command argument mangled (aux4/config serializes the object as non-JSON), so the
// warm app would register zero routes. Read the app config straight from the file
// instead — the same source `api openapi` uses — so REST routes register correctly.
function loadConfigFromFile(configFile) {
  const parsed = yaml.load(fs.readFileSync(configFile, "utf-8")) || {};
  return parsed.config ? parsed.config : parsed;
}

function resolveConfig(config) {
  if (!config._configFile) return config;
  try {
    return { ...config, ...loadConfigFromFile(config._configFile), _configFile: config._configFile };
  } catch {
    return config;
  }
}

// mtime of the config file, used to decide whether the cached warm app is stale.
function configMtime(config) {
  if (!config._configFile) return null;
  try {
    return fs.statSync(config._configFile).mtimeMs;
  } catch {
    return null;
  }
}

// The full Fastify app, built ONCE and wrapped by @fastify/aws-lambda, then
// cached so a warm Lambda container reuses it across invocations (no per-request
// rebuild — the key difference from `api handle`). Because it is the REAL app,
// every plugin works: REST, @fastify/static (static files), downloads, multipart,
// views. Only the socket-only features (WebSocket, SSE streaming) are out.
let cachedHandler;
let cachedConfigMtime;

async function buildHandler(config) {
  // Rebuild only when the app has never been built OR the config file changed on
  // disk (a cheap stat — a no-op on the common unchanged path). This preserves the
  // warm-reuse optimization while letting a hot config update (env/redeploy syncs a
  // new /tmp/config.yaml) take effect without a cold start.
  const mtime = configMtime(config);
  if (!cachedHandler || mtime !== cachedConfigMtime) {
    const app = await new Server({ ...resolveConfig(config), _returnApp: true }).start();
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
    cachedConfigMtime = mtime;
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

// --- Warm-container state sync barrier (SFA-147) -------------------------------
//
// A warm api-type Lambda reuses its /tmp filesystem across invocations, and several
// warm siblings each hold their OWN copy of the app's local state (the per-app
// SQLite conversation store under /tmp/state/apps, managed by cloud-file-sync). The
// VM image pulls that state ONLY at cold start and pushes it after a write; without a
// re-pull before the NEXT stateful request a warm sibling answers from a stale fs, so
// a chat turn saved by container A is invisible to container B — messages get lost.
//
// The fix mirrors command-type's pull-before-each-invocation (CLOUD-077): before a
// STATEFUL app action we pull fresh state; after a write we push. Pulling before every
// request (static assets, the SPA shell, /api/me, health) added a control-plane
// round-trip to every response and regressed page latency, so it is gated to the app
// `/action/` endpoints via needsFreshState() and coalesced by a short in-process TTL.

// Route the SAME way @fastify/aws-lambda routes the request (pathParameterUsedAsPath:
// "proxy"): the greedy `{proxy+}` capture is the path AFTER base-path + stage stripping
// (e.g. "api/hello"), identical for the raw execute-api URL and the custom domain. Fall
// back to event.path / event.rawPath when there is no proxy param (root resource or a
// non-API-Gateway event). Always returned with a single leading slash so segment tests
// are stable.
function routePath(event) {
  if (!event) return "/";
  const proxy = event.pathParameters && event.pathParameters.proxy;
  let p = proxy != null ? proxy : (event.path || event.rawPath || "");
  if (typeof p !== "string") p = "";
  return p.startsWith("/") ? p : "/" + p;
}

// TRUE only for stateful app actions — the routes that read/write the per-app state
// store — so the pre-invoke pull runs for those and NOTHING else (static assets, the
// SPA shell, /api/me, health). The classification is purely the normalized route path
// containing the "/action/" segment; app action endpoints are served under
// .../action/<name>.
function needsFreshState(event) {
  return routePath(event).includes("/action/");
}

// Module-scope timestamp of the last pull attempt, for TTL coalescing. Reset per
// container (a fresh process = fresh clock), which is exactly the granularity we want.
let lastPullAt = 0;

// Best-effort pre-invoke state pull. Runs ONLY for stateful actions (needsFreshState),
// coalesced by AUX4_LAMBDA_PRE_INVOKE_TTL_MS (default 2000ms; 0 = pull every action) so
// back-to-back actions don't each pay a full pull round-trip. Prefers the IN-PROCESS
// engine module (AUX4_LAMBDA_PRE_INVOKE_MODULE -> cloud-file-sync sync-engine.mjs
// pullFromEnv) to avoid a per-pull node subprocess; on import/pull failure falls back to
// the shell hook AUX4_LAMBDA_PRE_INVOKE. A failed pull must NEVER abort the request —
// everything here is swallowed.
async function preInvokePull(event, env) {
  if (!needsFreshState(event)) return;

  const ttl = parseInt(env.AUX4_LAMBDA_PRE_INVOKE_TTL_MS, 10);
  const ttlMs = Number.isNaN(ttl) ? 2000 : ttl;
  const now = Date.now();
  if (ttlMs > 0 && now - lastPullAt < ttlMs) return; // coalesced — a recent pull still fresh
  lastPullAt = now; // count the attempt so a slow/failing pull still coalesces

  const modulePath = env.AUX4_LAMBDA_PRE_INVOKE_MODULE;
  if (modulePath) {
    try {
      const { pathToFileURL } = require("url");
      const mod = await import(pathToFileURL(modulePath).href);
      const pull = mod.pullFromEnv || (mod.default && mod.default.pullFromEnv);
      if (typeof pull === "function") {
        await pull(env);
        return; // in-process pull done — skip the shell fallback
      }
    } catch (e) {
      console.error("lambda-loop: in-process pre-invoke pull failed:", (e && e.message) || e);
    }
  }

  const preInvoke = env.AUX4_LAMBDA_PRE_INVOKE;
  if (preInvoke) {
    try { require("child_process").execSync(preInvoke, { stdio: "ignore" }); }
    catch (e) { console.error("lambda-loop: pre-invoke hook failed:", (e && e.message) || e); }
  }
}

// Best-effort post-invoke state push, run AFTER the response is posted (off the response
// path). Prefers the IN-PROCESS engine module (AUX4_LAMBDA_POST_INVOKE_MODULE ->
// pushFromEnv); falls back to the shell hook AUX4_LAMBDA_POST_INVOKE. Never throws.
async function postInvokePush(env) {
  const modulePath = env.AUX4_LAMBDA_POST_INVOKE_MODULE;
  if (modulePath) {
    try {
      const { pathToFileURL } = require("url");
      const mod = await import(pathToFileURL(modulePath).href);
      const push = mod.pushFromEnv || (mod.default && mod.default.pushFromEnv);
      if (typeof push === "function") {
        await push(env);
        return;
      }
    } catch (e) {
      console.error("lambda-loop: in-process post-invoke push failed:", (e && e.message) || e);
    }
  }

  const postInvoke = env.AUX4_LAMBDA_POST_INVOKE;
  if (postInvoke) {
    try { require("child_process").execSync(postInvoke, { stdio: "ignore" }); }
    catch (e) { console.error("lambda-loop: post-invoke hook failed:", (e && e.message) || e); }
  }
}

// Long-lived cloud runtime: build the Fastify app ONCE, then own the AWS Lambda
// runtime API loop so the warm app is reused across invocations. This replaces the
// old model (a fresh `api lambda` process per invocation, rebuilding Fastify every
// call ≈ 1s). It's pure Node — no aux4 nested-daemon — so it sidesteps that
// deadlock. Before a stateful action it pulls fresh state (needsFreshState +
// preInvokePull); after the response is posted it pushes state (postInvokePush) — both
// best-effort and off the response path — so warm siblings never serve stale state.
exports.lambdaLoop = async function lambdaLoop(config) {
  const api = process.env.AWS_LAMBDA_RUNTIME_API;
  if (!api) {
    console.error("lambda-loop: AWS_LAMBDA_RUNTIME_API is not set");
    process.exit(1);
  }
  const base = `http://${api}/2018-06-01/runtime`;

  // Optional bounded run: exit the loop after N handled invocations instead of looping
  // forever. Unset / 0 = run forever (the production default). A finite bound lets the
  // loop be driven to completion by a test harness (a mock runtime API) and supports a
  // graceful bounded drain.
  const maxInvocations = parseInt(process.env.AUX4_LAMBDA_MAX_INVOCATIONS, 10) || 0;
  let handled = 0;

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
        h = await buildHandler(config); // re-check config mtime; rebuild only if it changed on disk
        // Pull fresh state BEFORE handling a stateful action so a warm sibling never
        // serves a stale conversation store. Best-effort — never aborts the request.
        await preInvokePull(event, process.env);
        response = await h(event, {});
      } catch (err) {
        await fetch(`${base}/invocation/${requestId}/error`, { method: "POST", body: errBody(err) }).catch(() => {});
        continue;
      }

      await fetch(`${base}/invocation/${requestId}/response`, { method: "POST", body: JSON.stringify(response) });

      // Push state AFTER the response is posted (off the response path). In-process
      // pushFromEnv when available, else the shell hook. Best-effort — never throws.
      await postInvokePush(process.env);

      handled += 1;
      if (maxInvocations > 0 && handled >= maxInvocations) break;
    } catch (err) {
      // Transient runtime-API error: log and keep the warm process alive.
      console.error("lambda-loop: iteration error:", (err && err.message) || err);
    }
  }

  // Reached only on a bounded run (maxInvocations); the production loop runs forever and
  // the container is frozen/killed rather than exiting. Stop the warm daemon cleanly, then
  // exit — the runtime-API keep-alive sockets would otherwise hold the event loop open.
  CommandDaemon.stop();
  process.exit(0);
};

exports.buildHandler = buildHandler;
exports.needsFreshState = needsFreshState;
exports.preInvokePull = preInvokePull;
exports.postInvokePush = postInvokePush;
// Test-only: reset the module-scope pull-coalescing clock between cases.
exports._resetPullClock = () => { lastPullAt = 0; };
