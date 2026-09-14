const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const PACKAGE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const EXPORT_NAME = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
const loaded = new Map();
const activeSlots = new Map();

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function traceId(request) {
  const supplied = Object.entries(request.headers || {})
    .find(([name]) => name.toLowerCase() === "x-aux4-trace-id")?.[1];
  if (typeof supplied === "string" && /^[a-f0-9]{32}$/.test(supplied)) return supplied;
  return crypto.createHash("sha256").update(String(request.uuid || "")).digest("hex").slice(0, 32);
}

function normalizedBody(request) {
  const body = request.body;
  if (typeof body !== "string") return clone(body);
  const contentType = String(request.headers?.["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) return body;
  try { return JSON.parse(body); } catch { return body; }
}

function normalizedContext(request, pathParameters, event, principal, executionEnv, options, signal) {
  const url = new URL(request.url, `http://${request.headers?.host || "localhost"}`);
  const query = {};
  for (const [key, value] of url.searchParams.entries()) query[key] = value;
  const requestValue = deepFreeze({
    method: request.method,
    path: url.pathname.replace(/^\/api/, "") || "/",
    headers: clone(request.headers || {}),
    cookies: clone(request.cookies || {}),
    query,
    params: clone(pathParameters || {}),
    body: normalizedBody(request),
    ip: request.ip || "127.0.0.1"
  });
  return Object.freeze({
    request: requestValue,
    method: requestValue.method,
    path: requestValue.path,
    headers: requestValue.headers,
    cookies: requestValue.cookies,
    query: requestValue.query,
    params: requestValue.params,
    body: requestValue.body,
    principal: deepFreeze(clone(principal)),
    auth: Object.freeze({ accessToken: executionEnv?.AUX4_ACCESS_TOKEN || "" }),
    trace: Object.freeze({ id: traceId(request) }),
    event: deepFreeze(clone(event)),
    options,
    signal
  });
}

function validateResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("In-process handler must return { exitCode, stdout, stderr }");
  }
  if (!Number.isInteger(result.exitCode) || typeof result.stdout !== "string" || typeof result.stderr !== "string") {
    throw new Error("In-process handler returned an invalid command result");
  }
  return result;
}

async function dispose(entry) {
  if (!entry || !entry.retired || entry.active > 0 || entry.disposed) return;
  entry.disposed = true;
  loaded.delete(entry.key);
  try {
    const runtime = await entry.promise;
    const cleanup = typeof runtime === "function" ? runtime.dispose : runtime.dispose || runtime.clear;
    if (typeof cleanup === "function") await cleanup.call(runtime);
  } catch {
    // A failed load has no reusable state to clean up.
  }
}

class InProcessHandlerRegistry {
  constructor(config, commandPool, options = {}) {
    this.commandPool = commandPool;
    this.configIdentity = config._configIdentity || digest(config);
    this.hostIdentity = config._configFile
      ? path.resolve(config._configFile)
      : `memory:${config.port || "default"}`;
    this.definitions = new WeakMap();
    this.packageRoot = options.packageRoot || (name => {
      // Source-tree and installed-package layouts for aux4/api itself. This also
      // makes the published package's own integration fixtures verifiable without
      // inventing a second package lookup mechanism.
      for (const candidate of [path.resolve(__dirname, "../package"), path.resolve(__dirname, "..")]) {
        try {
          const manifest = JSON.parse(fs.readFileSync(path.join(candidate, ".aux4"), "utf8"));
          if (`${manifest.scope}/${manifest.name}` === name) return candidate;
        } catch { /* not this layout */ }
      }
      const base = process.env.AUX4_HOME_DIR || path.join(os.homedir(), ".aux4.config");
      return path.join(base, "packages", ...name.split("/"));
    });
  }

  definition(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("In-process handler configuration must be an object");
    }
    const cached = this.definitions.get(raw);
    if (cached) return cached;
    if (!PACKAGE_NAME.test(raw.package || "")) {
      throw new Error("In-process handler package must be a scope/name identifier");
    }
    if (typeof raw.module !== "string" || !raw.module || path.isAbsolute(raw.module)) {
      throw new Error("In-process handler module must be a package-relative path");
    }
    if (![".js", ".mjs", ".cjs"].includes(path.extname(raw.module))) {
      throw new Error("In-process handler module must be JavaScript");
    }
    const factory = raw.factory || "createHandler";
    const method = raw.method || "handle";
    if (!EXPORT_NAME.test(factory) || !EXPORT_NAME.test(method)) {
      throw new Error("In-process handler factory and method must be static export names");
    }
    if (raw.options !== undefined && (!raw.options || typeof raw.options !== "object" || Array.isArray(raw.options))) {
      throw new Error("In-process handler options must be an object");
    }

    const root = fs.realpathSync(this.packageRoot(raw.package));
    const modulePath = fs.realpathSync(path.resolve(root, raw.module));
    const relative = path.relative(root, modulePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("In-process handler module must remain inside its configured package");
    }
    const manifestPath = path.join(root, ".aux4");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (`${manifest.scope}/${manifest.name}` !== raw.package) {
      throw new Error("In-process handler package identity does not match its manifest");
    }
    const options = deepFreeze(clone(raw.options || {}));
    const identity = {
      package: raw.package,
      version: String(manifest.version || ""),
      module: relative,
      factory,
      method,
      routeIdentity: String(raw.identity || ""),
      configIdentity: this.configIdentity,
      options
    };
    const key = digest(identity);
    const definition = { key, modulePath, factory, method, options, identity: deepFreeze(identity) };
    this.definitions.set(raw, definition);
    return definition;
  }

  async load(raw, slot) {
    const definition = this.definition(raw);
    const slotKey = `${this.hostIdentity}:${slot}`;
    const previousKey = activeSlots.get(slotKey);
    if (previousKey && previousKey !== definition.key) {
      const previous = loaded.get(previousKey);
      if (previous) {
        previous.retired = true;
        await dispose(previous);
      }
    }
    activeSlots.set(slotKey, definition.key);

    let entry = loaded.get(definition.key);
    if (!entry) {
      entry = {
        key: definition.key,
        active: 0,
        retired: false,
        disposed: false,
        promise: this.import(definition)
      };
      loaded.set(definition.key, entry);
      entry.promise.catch(() => loaded.delete(definition.key));
    }
    return { entry, definition };
  }

  async import(definition) {
    const href = `${pathToFileURL(definition.modulePath).href}?aux4=${definition.key}`;
    const module = await import(href);
    const factory = module[definition.factory];
    if (typeof factory !== "function") {
      throw new Error(`In-process handler module does not export ${definition.factory}`);
    }
    const runtime = await factory({
      options: definition.options,
      identity: definition.identity
    });
    const callable = typeof runtime === "function" ? runtime : runtime?.[definition.method];
    if (typeof callable !== "function") {
      throw new Error(`In-process handler factory result does not expose ${definition.method}`);
    }
    return runtime;
  }

  async prepare(raw, slot) {
    const { entry } = await this.load(raw, slot);
    await entry.promise;
  }

  async execute(raw, slot, request, pathParameters, event, principal, executionEnv, timeout) {
    return this.commandPool.run(async signal => {
      const { entry, definition } = await this.load(raw, slot);
      entry.active++;
      try {
        const runtime = await entry.promise;
        const callable = typeof runtime === "function" ? runtime : runtime[definition.method];
        const context = normalizedContext(request, pathParameters, event, principal, executionEnv, definition.options, signal);
        return validateResult(await callable.call(runtime, context));
      } finally {
        entry.active--;
        await dispose(entry);
      }
    }, timeout);
  }
}

module.exports = { InProcessHandlerRegistry, normalizedContext, validateResult };
