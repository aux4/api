const Server = require("./Server");
const fs = require("fs");
const yaml = require("js-yaml");

// Read the app config (api/cors/server/components/…) from the config FILE. The warm
// path receives config values as COMMAND ARGUMENTS, but aux4/config serializes object
// values (the route map) as non-JSON, so those args are unusable for routes — the file
// is the source of truth. Cheap (a small YAML file) and only read when (re)building.
function loadConfigFromFile(configFile) {
  const parsed = yaml.load(fs.readFileSync(configFile, "utf-8")) || {};
  return parsed.config ? parsed.config : parsed;
}

// The config file (when one was passed via --configFile) wins over the argument-derived
// values for the keys it defines, so routes come from the file rather than the mangled
// `api` arg. No file → use the passed config unchanged (backward compatible).
function resolveConfig(config) {
  if (!config._configFile) return config;
  try {
    return { ...config, ...loadConfigFromFile(config._configFile), _configFile: config._configFile };
  } catch {
    return config;
  }
}

function configMtime(config) {
  if (!config._configFile) return null;
  try { return fs.statSync(config._configFile).mtimeMs; } catch { return null; }
}

// The full Fastify app, built ONCE and wrapped by @fastify/aws-lambda, then
// cached so a warm Lambda container reuses it across invocations (no per-request
// rebuild — the key difference from `api handle`). Because it is the REAL app,
// every plugin works: REST, @fastify/static (static files), downloads, multipart,
// views. Only the socket-only features (WebSocket, SSE streaming) are out.
let cachedHandler;
let cachedConfigMtime;

async function buildHandler(config) {
  // Reuse the warm app across invocations; rebuild ONLY when there is no app yet, or the
  // config file changed on disk since the last build. A config/env change churns the
  // container anyway, so in practice this rebuilds ~never — the per-invocation cost is
  // just the stat() in configMtime(), preserving the cold-start warm-reuse optimization.
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

// Long-lived cloud runtime: build the Fastify app ONCE, then own the AWS Lambda
// runtime API loop so the warm app is reused across invocations. This replaces the
// old model (a fresh `api lambda` process per invocation, rebuilding Fastify every
// call ≈ 1s). It's pure Node — no aux4 nested-daemon — so it sidesteps that
// deadlock. Stateful machines sync state to S3 via a push hook
// (AUX4_LAMBDA_POST_INVOKE / _MODULE) that, for state-mutating (/action/) requests,
// runs AFTER the handler but BEFORE the response is posted — because AWS can freeze
// the container the moment /response is written, an after-response push is unreliable
// (see the gated push below).
// Does this request read/write app state and therefore need the latest from the shared
// store first? Only the app `/action/` endpoints do (list sources, form onLoad reads, and
// mutations). Static assets, the SPA shell, /api/me etc. are served from local state and
// must NOT trigger a pull — pulling before every request is what regressed page latency.
function needsFreshState(event) {
  if (!event) return false;
  const rc = event.requestContext || {};
  const p =
    event.rawPath ||
    event.path ||
    rc.path ||
    (rc.http && rc.http.path) ||
    "";
  return typeof p === "string" && p.includes("/action/");
}

exports.lambdaLoop = async function lambdaLoop(config) {
  const api = process.env.AWS_LAMBDA_RUNTIME_API;
  if (!api) {
    console.error("lambda-loop: AWS_LAMBDA_RUNTIME_API is not set");
    process.exit(1);
  }
  const base = `http://${api}/2018-06-01/runtime`;
  const preInvoke = process.env.AUX4_LAMBDA_PRE_INVOKE;
  const postInvoke = process.env.AUX4_LAMBDA_POST_INVOKE;
  const { execSync } = require("child_process");

  // Preferred pre-invoke path: an ESM module run IN-PROCESS in this warm loop, not a
  // subprocess. AUX4_LAMBDA_PRE_INVOKE_MODULE is an absolute path whose default export (or
  // named `pullFromEnv`) is an async fn that does the state pull reading its config from the
  // environment. Spawning a fresh node per pull cost ~500ms just for process start + ESM
  // load; calling in-process removes that entirely. Loaded ONCE here; falls back to the
  // AUX4_LAMBDA_PRE_INVOKE subprocess if the module is unset or fails to import.
  const preInvokeModule = process.env.AUX4_LAMBDA_PRE_INVOKE_MODULE;
  let preInvokeFn = null;
  if (preInvokeModule) {
    try {
      const mod = await import(preInvokeModule);
      preInvokeFn = mod.pullFromEnv || mod.default || null;
      if (preInvokeFn) console.log(`lambda-loop: pre-invoke module loaded in-process: ${preInvokeModule}`);
      else console.error(`lambda-loop: pre-invoke module ${preInvokeModule} exports no pullFromEnv/default — using subprocess`);
    } catch (e) {
      console.error(`lambda-loop: failed to import pre-invoke module ${preInvokeModule} (${e.message}) — using subprocess`);
    }
  }

  // Same idea for the post-invoke push (pushFromEnv), so the after-response state push runs
  // in-process (~30ms) rather than spawning a node/aux4 subprocess (~600ms). That frees the
  // container for the next request quickly and shrinks the window in which a read right after
  // a write could miss it. Falls back to the AUX4_LAMBDA_POST_INVOKE subprocess.
  const postInvokeModule = process.env.AUX4_LAMBDA_POST_INVOKE_MODULE;
  let postInvokeFn = null;
  if (postInvokeModule) {
    try {
      const mod = await import(postInvokeModule);
      postInvokeFn = mod.pushFromEnv || mod.default || null;
      if (postInvokeFn) console.log(`lambda-loop: post-invoke module loaded in-process: ${postInvokeModule}`);
    } catch (e) {
      console.error(`lambda-loop: failed to import post-invoke module ${postInvokeModule} (${e.message}) — using subprocess`);
    }
  }

  // Pre-invoke pull coalescing window (AUX4_LAMBDA_PRE_INVOKE_TTL_MS). DEFAULT 0 = never
  // coalesce: run the pull before EVERY /action/ request.
  //
  // Why 0 (correctness): a positive TTL suppresses the pre-invoke pull for any /action/
  // request that arrives within `ttl` ms of this container's LAST pull. But a write made on
  // ANOTHER warm container in that window is invisible to this container until it pulls, so a
  // read served inside the window returns the STALE local file — a cross-container
  // read-after-write violation. The concrete symptom: rename a task (writes + pushes on
  // container A) then the redirect re-fetches (task-get on container B) and shows the OLD
  // title; a manual refresh "fixes" it only because enough time passed for B's TTL to lapse.
  // There is no time-based way to tell a same-page read burst apart from a post-write
  // re-fetch, and this container cannot know another container wrote without consulting the
  // shared store — so the ONLY correct answer is to check the shared store on every read.
  //
  // Why this stays fast: the check is cloud-file-sync's pull FAST PATH — a single direct-to-S3
  // GET of the small `.manifest.json` via a presigned URL cached from the last pull-plan (NO
  // control-plane round-trip). If the manifest is byte-identical nothing is downloaded; only a
  // genuinely-changed manifest triggers the file download (necessary work — there IS a change
  // to fetch). So the per-request cost is one small S3 GET (~tens of ms), not the ~1s
  // control-plane pull-plan that the original coalescing was protecting against (that rationale
  // predates the fast path). Push ordering (files THEN manifest, both awaited BEFORE the
  // response) plus S3 read-after-write consistency make the just-written state observable by
  // the time the client's re-fetch reaches any container.
  //
  // The env var remains as a latency-tuning ESCAPE HATCH; any positive value re-introduces a
  // read-after-write staleness window of up to that many ms and should be set only knowingly.
  const rawPreInvokeTtl = Number(process.env.AUX4_LAMBDA_PRE_INVOKE_TTL_MS);
  const preInvokeTtlMs = Number.isFinite(rawPreInvokeTtl) && rawPreInvokeTtl > 0 ? rawPreInvokeTtl : 0;
  let lastPreInvoke = 0;

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

      // Optional pre-invocation hook (AUX4_LAMBDA_PRE_INVOKE): pull the latest shared state
      // from S3 BEFORE the handler so a warm container sees writes made on OTHER containers
      // (e.g. a list that must reflect a just-deleted row, or a task page that must reflect a
      // just-renamed title). Gated by needsFreshState — only the app `/action/` data endpoints
      // pull; static assets, the SPA shell and /api/me stay pull-free, which is what preserves
      // page latency. The pull runs on every /action/ request by default (preInvokeTtlMs = 0)
      // because that is the only way to GUARANTEE cross-container read-after-write; it is cheap
      // (the fast-path direct-to-S3 manifest GET, no download when unchanged). A positive
      // AUX4_LAMBDA_PRE_INVOKE_TTL_MS coalesces a burst at the cost of a staleness window.
      if ((preInvokeFn || preInvoke) && needsFreshState(event)) {
        const now = Date.now();
        if (now - lastPreInvoke >= preInvokeTtlMs) {
          lastPreInvoke = now;
          if (preInvokeFn) {
            // In-process: no subprocess, no node startup — just the pull's own work.
            try { await preInvokeFn(); }
            catch (e) { console.error("lambda-loop: in-process pre-invoke failed:", e.message); }
          } else {
            try { execSync(preInvoke, { stdio: "ignore" }); }
            catch (e) { console.error("lambda-loop: pre-invoke hook failed:", e.message); }
          }
        }
      }

      // Rebuild the app only if the config file changed on disk since the last build
      // (a cheap stat inside buildHandler; a no-op when unchanged). This keeps a warm
      // container correct if the seeded config is ever hot-updated, without paying a
      // rebuild on the common unchanged path.
      h = await buildHandler(config);

      let response;
      try {
        response = await h(event, {});
      } catch (err) {
        await fetch(`${base}/invocation/${requestId}/error`, { method: "POST", body: errBody(err) }).catch(() => {});
        continue;
      }

      // Persist state to S3 BEFORE posting the response — NOT after. In this custom Lambda
      // runtime the container can be FROZEN the instant the response is posted (AWS treats the
      // invocation as done once /response is written), so an after-response push may not run
      // until the NEXT invocation thaws the container. That makes a just-written record
      // invisible to a read served by another warm container until then — the exact "created
      // an article but it only shows after a refresh" / "delete+update don't reflect" symptom.
      // Pushing before the response guarantees the write is durable by the time the client
      // proceeds (e.g. the SPA's redirect to a list that a DIFFERENT container serves, which
      // then pre-invoke-pulls the fresh state). Gated to /action/ requests (the only ones that
      // mutate app state); on a pure read the push is a cheap SHA1-diff no-op. In-process
      // (pushFromEnv) — no subprocess; the AUX4_LAMBDA_POST_INVOKE subprocess is the fallback.
      if (needsFreshState(event)) {
        if (postInvokeFn) {
          try { await postInvokeFn(); }
          catch (e) { console.error("lambda-loop: in-process pre-response push failed:", e.message); }
        } else if (postInvoke) {
          try { execSync(postInvoke, { stdio: "ignore" }); }
          catch (e) { console.error("lambda-loop: pre-response push hook failed:", e.message); }
        }
      }

      await fetch(`${base}/invocation/${requestId}/response`, { method: "POST", body: JSON.stringify(response) });
    } catch (err) {
      // Transient runtime-API error: log and keep the warm process alive.
      console.error("lambda-loop: iteration error:", (err && err.message) || err);
    }
  }
};

exports.buildHandler = buildHandler;
