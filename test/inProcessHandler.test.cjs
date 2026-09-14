const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { CommandPool, CommandPoolTimeoutError } = require("../lib/CommandPool");
const { InProcessHandlerRegistry } = require("../lib/InProcessHandlerRegistry");
const RestHandler = require("../lib/handler/RestHandler");
const RateLimiter = require("../lib/middleware/RateLimiter");

const packageRoot = path.join(__dirname, "fixtures", "in-process-package");
const moduleDefinition = options => ({
  package: "test/in-process-package",
  module: "handler.mjs",
  factory: "createHandler",
  method: "handle",
  identity: "test-handler",
  options
});

function registry(config, pool) {
  return new InProcessHandlerRegistry(config, pool, { packageRoot: () => packageRoot });
}

function request(overrides = {}) {
  return {
    method: "POST",
    url: "/api/items/item-1?mode=fast",
    headers: {
      host: "localhost",
      "content-type": "application/json",
      "x-aux4-trace-id": "abcdef0123456789abcdef0123456789"
    },
    cookies: { session: "opaque" },
    body: '{"message":"hello"}',
    ip: "192.0.2.4",
    uuid: "request-1",
    ...overrides
  };
}

test.beforeEach(() => {
  globalThis.__aux4InProcessFixture = {
    factories: 0,
    calls: 0,
    disposals: 0,
    active: 0,
    maxActive: 0
  };
});

test("loads once and passes a frozen normalized request, principal, and trace context", async () => {
  const pool = new CommandPool({ maxConcurrency: 2, maxQueue: 2 });
  const config = { _configIdentity: "config-v1", _configFile: "/tmp/aux4-api-test.yaml" };
  const modules = registry(config, pool);
  const definition = moduleDefinition({ marker: "trusted-config" });
  const event = { httpMethod: "POST", path: "/items/item-1" };

  await modules.prepare(definition, "rest:POST:/items/{id}");
  const first = await modules.execute(
    definition,
    "rest:POST:/items/{id}",
    request({ body: '{"handler":{"module":"/tmp/attacker.mjs"}}' }),
    { id: "item-1" },
    event,
    { sub: "user-1" },
    { AUX4_ACCESS_TOKEN: "delegated-token" },
    1000
  );
  const second = await modules.execute(
    definition,
    "rest:POST:/items/{id}",
    request(),
    { id: "item-1" },
    event,
    { sub: "user-1" },
    undefined,
    1000
  );

  const output = JSON.parse(first.stdout);
  assert.equal(first.exitCode, 0);
  assert.equal(output.package, "test/in-process-package");
  assert.equal(output.marker, "trusted-config");
  assert.deepEqual(output.request.body, { handler: { module: "/tmp/attacker.mjs" } });
  assert.deepEqual(output.request.params, { id: "item-1" });
  assert.deepEqual(output.request.query, { mode: "fast" });
  assert.deepEqual(output.principal, { sub: "user-1" });
  assert.deepEqual(output.auth, { accessToken: "delegated-token" });
  assert.equal(output.traceId, "abcdef0123456789abcdef0123456789");
  assert.equal(output.frozen, true);
  assert.equal(second.exitCode, 0);
  assert.equal(globalThis.__aux4InProcessFixture.factories, 1);
  assert.equal(globalThis.__aux4InProcessFixture.calls, 2);
});

test("rejects module traversal and manifest identity mismatches before import", async () => {
  const modules = registry({ _configIdentity: "security" }, new CommandPool());
  await assert.rejects(
    modules.prepare({ ...moduleDefinition({}), module: "../outside.mjs" }, "rest:bad"),
    /ENOENT|inside its configured package/
  );
  await assert.rejects(
    modules.prepare({ ...moduleDefinition({}), package: "other/package" }, "rest:bad"),
    /identity does not match|realpath/
  );
});

test("invalidates a warm runtime when the trusted config identity changes", async () => {
  const pool = new CommandPool();
  const first = registry({ _configIdentity: "config-v1", _configFile: "/tmp/shared-config.yaml" }, pool);
  await first.execute(moduleDefinition({ marker: "v1" }), "rest:POST:/chat", request(), {}, {}, null, undefined, 1000);

  const second = registry({ _configIdentity: "config-v2", _configFile: "/tmp/shared-config.yaml" }, pool);
  const result = await second.execute(moduleDefinition({ marker: "v2" }), "rest:POST:/chat", request(), {}, {}, null, undefined, 1000);

  assert.equal(JSON.parse(result.stdout).marker, "v2");
  assert.equal(globalThis.__aux4InProcessFixture.factories, 2);
  assert.equal(globalThis.__aux4InProcessFixture.disposals, 1);
});

test("shares command concurrency and keeps the slot until a timed-out handler settles", async () => {
  const pool = new CommandPool({ maxConcurrency: 1, maxQueue: 2 });
  const modules = registry({ _configIdentity: "timeout" }, pool);
  const definition = moduleDefinition({ delayMs: 50 });
  const started = Date.now();

  await assert.rejects(
    modules.execute(definition, "rest:slow", request(), {}, {}, null, undefined, 10),
    error => error instanceof CommandPoolTimeoutError && /execution timed out/.test(error.message)
  );
  const second = await modules.execute(definition, "rest:slow", request(), {}, {}, null, undefined, 200);

  assert.equal(second.exitCode, 0);
  assert.ok(Date.now() - started >= 90);
  assert.equal(globalThis.__aux4InProcessFixture.maxActive, 1);
});

test("REST in-process output follows the existing proxy response contract", async t => {
  const config = {
    _configIdentity: "rest",
    api: {
      "POST /items/{id}": {
        command: "aux4 legacy fallback",
        handler: moduleDefinition({ marker: "route" })
      }
    }
  };
  const pool = new CommandPool();
  const modules = registry(config, pool);
  const rateLimiter = new RateLimiter();
  t.after(() => rateLimiter.destroy());
  const handler = new RestHandler(config, rateLimiter, pool, { moduleRegistry: modules });
  await handler.prepare();

  const response = await handler.dispatch({
    httpMethod: "POST",
    path: "/items/item-1",
    headers: {
      "content-type": "application/json",
      "x-aux4-trace-id": "abcdef0123456789abcdef0123456789"
    },
    queryStringParameters: { mode: "fast" },
    body: '{"message":"hello"}',
    isBase64Encoded: false,
    requestContext: {
      requestId: "request-1",
      identity: { sourceIp: "192.0.2.4" },
      authorizer: { sub: "user-1" }
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "application/json");
  const body = JSON.parse(response.body);
  assert.equal(body.marker, "route");
  assert.deepEqual(body.principal, { sub: "user-1" });
  assert.equal(globalThis.__aux4InProcessFixture.calls, 1);
});

test("in-process auth validator preserves bearer principal and cache semantics", async () => {
  const config = {
    _configIdentity: "auth",
    security: {
      auth: {
        type: "bearer",
        cacheTTL: 60000,
        handler: moduleDefinition({ auth: true })
      }
    },
    api: {
      "GET /private": { handler: moduleDefinition({ marker: "private" }) }
    }
  };
  const pool = new CommandPool();
  const modules = registry(config, pool);
  const handler = new RestHandler(config, null, pool, { moduleRegistry: modules });
  await handler.prepare();
  const event = {
    httpMethod: "GET",
    path: "/private",
    headers: { authorization: "Bearer valid-token" },
    body: null,
    requestContext: { requestId: "auth-request", identity: { sourceIp: "127.0.0.1" } }
  };

  const first = await handler.dispatch(event);
  const second = await handler.dispatch(event);

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(JSON.parse(first.body).principal, { sub: "user-1", scope: "demo" });
  assert.equal(globalThis.__aux4InProcessFixture.calls, 3); // one auth + two route calls
});

test("in-process auth fails closed when a validator does not return a JSON principal", async () => {
  const config = {
    _configIdentity: "invalid-auth",
    security: { auth: { type: "bearer", handler: moduleDefinition({ invalidAuth: true }) } },
    api: { "GET /private": { handler: moduleDefinition({ marker: "must-not-run" }) } }
  };
  const pool = new CommandPool();
  const modules = registry(config, pool);
  const handler = new RestHandler(config, null, pool, { moduleRegistry: modules });
  await handler.prepare();

  const response = await handler.dispatch({
    httpMethod: "GET",
    path: "/private",
    headers: { authorization: "Bearer valid-token" },
    body: null,
    requestContext: { requestId: "invalid-auth", identity: { sourceIp: "127.0.0.1" } }
  });

  assert.equal(response.statusCode, 401);
  assert.equal(globalThis.__aux4InProcessFixture.calls, 1);
});
