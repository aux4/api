const fs = require("fs");
const yaml = require("js-yaml");
const Command = require("./Command");
const { execSync } = require("child_process");
const path = require("path");
const { pathToFileURL } = require("url");
const { ExecutionGrantCache } = require("./ExecutionGrantCache");
const { createExecutionTiming } = require("./ExecutionTiming");
const { CommandPool } = require("./CommandPool");
const { WebSocketLambdaHandler, isWebSocketEvent } = require("./handler/WebSocketLambdaHandler");

const EXECUTION_EVENT_VERSION = "aux4.execution.v1";
const SAFE_COMMAND_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const executionGrants = new ExecutionGrantCache();

function executionApiBase() {
  if (process.env.AUX4_CLOUD_API_URL) return process.env.AUX4_CLOUD_API_URL.replace(/\/$/, "");
  if (process.env.CLOUD_API_BASE_URL) return process.env.CLOUD_API_BASE_URL.replace(/\/$/, "");
  const syncUrl = process.env.CLOUD_SYNC_URL || "";
  return syncUrl.replace(/\/v1\/sync\/(?:urls|pull-plan)\/?$/, "").replace(/\/$/, "");
}

function isExecutionEvent(event) {
  return event && event.version === EXECUTION_EVENT_VERSION;
}

function commandArgs(event) {
  if (!Array.isArray(event.command) || event.command.length === 0) {
    throw new Error("Execution event command must be a non-empty array");
  }
  const command = event.command.map(value => String(value));
  if (!command.every(segment => SAFE_COMMAND_SEGMENT.test(segment))) {
    throw new Error("Execution event contains an invalid command segment");
  }

  const args = [...command];
  const params = event.params || {};
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Execution event params must be an object");
  }
  for (const [name, value] of Object.entries(params)) {
    if (!SAFE_COMMAND_SEGMENT.test(name)) throw new Error("Execution event contains an invalid parameter name");
    args.push(`--${name}`, typeof value === "string" ? value : JSON.stringify(value));
  }
  return args;
}

async function getExecutionAuthorization(executionId, traceId) {
  const baseUrl = executionApiBase();
  const machineToken = process.env.CLOUD_SYNC_TOKEN;
  if (!baseUrl || !machineToken) throw new Error("Cloud execution identity is not configured");
  const response = await fetch(
    `${baseUrl}/v1/executions/${encodeURIComponent(executionId)}/token`,
    { headers: { Authorization: `Bearer ${machineToken}`, "X-Aux4-Trace-Id": traceId } }
  );
  if (!response.ok) {
    const error = new Error(`Cloud execution authorization failed (${response.status})`);
    error.statusCode = response.status;
    throw error;
  }
  const body = await response.json();
  if (typeof body.accessToken !== "string" || !body.accessToken ||
      typeof body.command !== "string" || !body.command ||
      (body.executionId !== undefined && body.executionId !== executionId)) {
    throw new Error("Cloud execution authorization returned an incomplete grant");
  }
  return body;
}

async function executionAuthorization(executionId, timing) {
  const started = timing.start();
  const cached = executionGrants.get(executionId);
  timing.record("grant.cache", started, "ok", Boolean(cached));
  if (cached) return cached;
  // Only retry this read-only exchange, never a command that may have effects.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const grant = await timing.measure("grant.fetch", () => getExecutionAuthorization(executionId, timing.traceId));
      executionGrants.set(executionId, grant);
      return grant;
    } catch (error) {
      if (![401, 403].includes(error.statusCode) || attempt !== 0) throw error;
      executionGrants.delete(executionId);
    }
  }
}

function assertAuthorizedCommand(requestedArgs, authorizedCommand) {
  const allowed = String(authorizedCommand || "").split(" ").filter(Boolean);
  if (
    allowed.length === 0 ||
    requestedArgs.length < allowed.length ||
    allowed.some((segment, index) => requestedArgs[index] !== segment)
  ) {
    throw new Error("Execution event command is not authorized by its grant");
  }
}

async function completeExecution(executionId) {
  const baseUrl = executionApiBase();
  const machineToken = process.env.CLOUD_SYNC_TOKEN;
  if (!baseUrl || !machineToken) return;
  const response = await fetch(`${baseUrl}/v1/executions/${encodeURIComponent(executionId)}/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${machineToken}` }
  });
  if (!response.ok) throw new Error(`Cloud execution completion failed (${response.status})`);
}

let executionSyncModule;

async function loadExecutionSyncModule(modulePath) {
  if (!executionSyncModule || executionSyncModule.path !== modulePath) {
    executionSyncModule = {
      path: modulePath,
      promise: import(pathToFileURL(path.resolve(modulePath)).href)
    };
  }
  return executionSyncModule.promise;
}

async function runExecutionHook(phase, traceEnv = {}) {
  const modulePath = process.env.AUX4_LAMBDA_EXECUTION_SYNC_MODULE;
  if (modulePath) {
    const sync = await loadExecutionSyncModule(modulePath);
    const operation = phase === "pre" ? sync.pullFromEnv : sync.pushFromEnv;
    if (typeof operation !== "function") {
      throw new Error(`Execution sync module does not export ${phase === "pre" ? "pullFromEnv" : "pushFromEnv"}`);
    }
    return operation({ ...process.env, ...traceEnv });
  }

  const envName = phase === "pre"
    ? "AUX4_LAMBDA_EXECUTION_PRE_INVOKE"
    : "AUX4_LAMBDA_EXECUTION_POST_INVOKE";
  const command = process.env[envName];
  if (command) execSync(command, { stdio: "ignore", env: { ...process.env, ...traceEnv } });
}

async function executeExecutionEvent(event, timing) {
  const executionId = String(event.executionId || "");
  if (!executionId) throw new Error("Execution event is missing executionId");
  const authorization = await executionAuthorization(executionId, timing);
  const args = await timing.measure("command.validation", () => {
    const args = commandArgs(event);
    assertAuthorizedCommand(args, authorization.command);
    return args;
  });
  const result = await timing.measure("command.execution", async () => {
    const result = await Command.executeFile(
      "aux4",
      args,
      event.stdin,
      Number(event.timeoutMs) || undefined,
      {
        AUX4_ACCESS_TOKEN: authorization.accessToken,
        AUX4_EXECUTION_ID: executionId,
        AUX4_TRACE_ID: timing.traceId,
        AUX4_EXECUTION_PHASE: timing.phase
      }
    );
    timing.relay(result.stderr);
    if (result.exitCode !== 0) {
      const error = new Error((result.stderr || "Execution command failed").trim());
      error.name = "Aux4ExecutionError";
      throw error;
    }
    return result;
  });
  const output = (result.stdout || "").trim();
  if (!output) return null;
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

async function handleExecutionEvent(event, options = {}) {
  const runHook = options.runHook || runExecutionHook;
  const timing = createExecutionTiming(event, options.emitTiming);
  const started = timing.start();
  const traceEnv = { AUX4_TRACE_ID: timing.traceId, AUX4_EXECUTION_PHASE: timing.phase };
  let status = "error";
  let response;
  try {
    await timing.measure("sync.pre", () => runHook("pre", traceEnv));
    try {
      response = await executeExecutionEvent(event, timing);
    } finally {
      // Do not acknowledge a phase until its checkpoint is durable.
      await timing.measure("sync.post", () => runHook("post", traceEnv));
    }
    if (response && response.status === "final") {
      await timing.measure("completion", () => completeExecution(String(event.executionId))).catch(() => {});
    }
    status = "ok";
    return response;
  } finally {
    // Evict even when checkpoint/completion fails after a final command result.
    if (response && response.status === "final") executionGrants.delete(String(event.executionId));
    timing.record("phase.total", started, status);
  }
}

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
    const Server = require("./Server");
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

let cachedWebSocketHandler;
let cachedWebSocketConfigMtime;

function buildWebSocketHandler(config) {
  const mtime = configMtime(config);
  if (!cachedWebSocketHandler || mtime !== cachedWebSocketConfigMtime) {
    const resolved = resolveConfig(config);
    const commandPool = new CommandPool({
      maxConcurrency: resolved.server?.maxConcurrency,
      maxQueue: resolved.server?.maxQueue
    });
    cachedWebSocketHandler = new WebSocketLambdaHandler(resolved, commandPool);
    cachedWebSocketConfigMtime = mtime;
  }
  return cachedWebSocketHandler;
}

async function dispatchLambdaEvent(config, event, context = {}) {
  if (isExecutionEvent(event)) return handleExecutionEvent(event);
  if (isWebSocketEvent(event)) return buildWebSocketHandler(config).dispatch(event);
  const handler = await buildHandler(config);
  return handler(event, context);
}

// AWS Lambda Node runtime entrypoint: `handler(event, context)`. The api image
// sets `_config` (or seeds it) before the runtime imports this module.
exports.handler = async (event, context) => {
  return dispatchLambdaEvent(exports._config || {}, event, context);
};

// CLI / local: read a single API-Gateway proxy event from stdin, run it through
// the adapter, and print the proxy response to stdout — parity with `api handle`
// for testing, but exercising the full app.
exports.lambdaCommand = async function lambdaCommand(config) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim() || "{}";
  const event = JSON.parse(raw);
  const response = await dispatchLambdaEvent(config, event, {});
  process.stdout.write(JSON.stringify(response) + "\n", () => process.exit(0));
};

// Long-lived cloud runtime: build the Fastify app ONCE, then own the AWS Lambda
// runtime API loop so the warm app is reused across invocations. This replaces the
// old model (a fresh `api lambda` process per invocation, rebuilding Fastify every
// call ≈ 1s). It's pure Node — no aux4 nested-daemon — so it sidesteps that
// deadlock. Ordinary HTTP requests keep their optional state push off the response
// path. Structured executions instead use pre/post hooks inside
// handleExecutionEvent so their local checkpoint is refreshed before the command
// and made durable before Step Functions can advance to the next phase.
exports.lambdaLoop = async function lambdaLoop(config) {
  const api = process.env.AWS_LAMBDA_RUNTIME_API;
  if (!api) {
    console.error("lambda-loop: AWS_LAMBDA_RUNTIME_API is not set");
    process.exit(1);
  }
  const base = `http://${api}/2018-06-01/runtime`;
  const postInvoke = process.env.AUX4_LAMBDA_POST_INVOKE;

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

  for (;;) {
    let requestId;
    try {
      const next = await fetch(`${base}/invocation/next`); // long-poll: blocks until an invocation
      requestId = next.headers.get("lambda-runtime-aws-request-id");
      const event = await next.json();
      const executionEvent = isExecutionEvent(event);

      let response;
      try {
        if (executionEvent) {
          response = await handleExecutionEvent(event);
        } else if (isWebSocketEvent(event)) {
          response = await buildWebSocketHandler(config).dispatch(event);
        } else {
          const h = await buildHandler(config); // build lazily; re-check config mtime on REST events
          response = await h(event, {});
        }
      } catch (err) {
        await fetch(`${base}/invocation/${requestId}/error`, { method: "POST", body: errBody(err) }).catch(() => {});
        continue;
      }

      await fetch(`${base}/invocation/${requestId}/response`, { method: "POST", body: JSON.stringify(response) });

      if (postInvoke && !executionEvent) {
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
exports.buildWebSocketHandler = buildWebSocketHandler;
exports.dispatchLambdaEvent = dispatchLambdaEvent;
exports.handleExecutionEvent = handleExecutionEvent;
exports.runExecutionHook = runExecutionHook;
exports.commandArgs = commandArgs;
exports.assertAuthorizedCommand = assertAuthorizedCommand;
