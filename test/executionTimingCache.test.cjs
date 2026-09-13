const test = require("node:test");
const assert = require("node:assert/strict");
const Command = require("../lib/Command");
const { ExecutionGrantCache, cacheDeadline } = require("../lib/ExecutionGrantCache");
const { handleExecutionEvent } = require("../lib/lambdaHandler");

const now = 1800000000000;
const grant = (overrides = {}) => ({
  accessToken: "secret-token", command: "agent-manager kb orchestrate",
  expiresAt: now / 1000 + 600, executionExpiresAt: now / 1000 + 600, ...overrides
});

test("cache respects both expiry bounds, token exp, safety margin, and five-minute cap", () => {
  assert.equal(cacheDeadline(grant(), now), now + 300000);
  assert.equal(cacheDeadline(grant({ expiresAt: now / 1000 + 100 }), now), now + 70000);
  assert.equal(cacheDeadline(grant({ executionExpiresAt: now / 1000 + 50 }), now), now + 20000);
  const jwt = `header.${Buffer.from(JSON.stringify({ exp: now / 1000 + 40 })).toString("base64url")}.signature`;
  assert.equal(cacheDeadline(grant({ accessToken: jwt }), now), now + 10000);
  assert.equal(cacheDeadline(grant({ expiresAt: "invalid" }), now), now);
  assert.equal(cacheDeadline(grant({ expiresAt: undefined, executionExpiresAt: undefined }), now), now);
});

test("cache is bounded, execution-isolated, LRU, and expires at the boundary", () => {
  const cache = new ExecutionGrantCache();
  for (let index = 0; index < 128; index++) cache.set(String(index), grant(), now);
  assert.ok(cache.get("0", now));
  cache.set("new", grant(), now);
  assert.equal(cache.get("1", now), null);
  assert.ok(cache.get("0", now));
  assert.equal(cache.get("missing", now), null);
  assert.ok(cache.get("new", now + 299999));
  assert.equal(cache.get("new", now + 300000), null);
});

function fixture(t) {
  const originals = { fetch: global.fetch, execute: Command.executeFile, env: process.env, now: Date.now };
  let clock = now;
  process.env = { ...process.env, AUX4_CLOUD_API_URL: "https://example.invalid", CLOUD_SYNC_TOKEN: "secret-machine-key" };
  Date.now = () => clock;
  t.after(() => {
    global.fetch = originals.fetch;
    Command.executeFile = originals.execute;
    process.env = originals.env;
    Date.now = originals.now;
  });
  const calls = [], commands = [], lines = [], order = [];
  global.fetch = async url => {
    calls.push(url);
    order.push(url.endsWith("/complete") ? "completion" : "fetch");
    return { ok: true, json: async () => grant() };
  };
  Command.executeFile = async (...args) => {
    commands.push(args);
    return { exitCode: 0, stdout: '{"status":"continue"}', stderr: "" };
  };
  const event = {
    executionId: `private-execution-${t.name}`, version: "aux4.execution.v1",
    command: ["agent-manager", "kb", "orchestrate", "call-llm"],
    params: { question: "secret-question" }
  };
  const options = { emitTiming: line => lines.push(JSON.parse(line)), runHook: phase => order.push(phase) };
  return { event, options, calls, commands, lines, order, advance: ms => { clock += ms; } };
}

test("warm phases reuse grants but recheck the exact prefix and refresh expired entries", async t => {
  const f = fixture(t);
  await handleExecutionEvent(f.event, f.options);
  await handleExecutionEvent({ ...f.event, command: ["agent-manager", "kb", "orchestrate", "apply-results"] }, f.options);
  assert.equal(f.calls.length, 1);
  assert.equal(f.commands.length, 2);
  assert.equal(f.lines.filter(line => line.span === "grant.cache").at(-1).cacheHit, true);
  await assert.rejects(handleExecutionEvent({ ...f.event, command: ["agent-manager", "kb-other", "orchestrate", "call-llm"] }, f.options), /not authorized/);
  assert.equal(f.commands.length, 2);
  assert.equal(f.calls.length, 1);
  f.advance(300000);
  await handleExecutionEvent(f.event, f.options);
  assert.equal(f.calls.length, 2);
});

test("final results evict even when the post checkpoint fails", async t => {
  const f = fixture(t);
  Command.executeFile = async () => ({ exitCode: 0, stdout: '{"status":"final"}', stderr: "" });
  await assert.rejects(handleExecutionEvent(f.event, {
    ...f.options, runHook: phase => { if (phase === "post") throw new Error("checkpoint failed"); }
  }), /checkpoint failed/);
  assert.equal(f.calls.length, 1);
  await handleExecutionEvent(f.event, f.options);
  assert.equal(f.calls.length, 3); // fetch again, then completion
  await handleExecutionEvent(f.event, f.options);
  assert.equal(f.calls.length, 5); // successful completion also evicts
});

test("only an auth-rejected grant fetch is retried once; child errors never replay", async t => {
  const f = fixture(t);
  let fetches = 0;
  global.fetch = async () => ++fetches === 1
    ? { ok: false, status: 401 }
    : { ok: true, json: async () => grant() };
  await handleExecutionEvent(f.event, f.options);
  assert.equal(fetches, 2);
  let executions = 0;
  Command.executeFile = async () => {
    executions++;
    return { exitCode: 1, stdout: "", stderr: "401 authentication rejected" };
  };
  await assert.rejects(handleExecutionEvent(f.event, f.options), /401 authentication rejected/);
  assert.equal(executions, 1);
  assert.equal(fetches, 2);
  for (const [status, expected] of [[403, 2], [500, 1]]) {
    fetches = 0;
    global.fetch = async () => { fetches++; return { ok: false, status }; };
    await assert.rejects(handleExecutionEvent({ ...f.event, executionId: `${f.event.executionId}-${status}` }, f.options));
    assert.equal(fetches, expected);
  }
});

test("spans are ordered, redact input, propagate correlation, and relay only valid child telemetry", async t => {
  const f = fixture(t);
  const childLines = [];
  Command.executeFile = async (...args) => {
    const env = args[4];
    assert.match(env.AUX4_TRACE_ID, /^[a-f0-9]{32}$/);
    assert.equal(env.AUX4_EXECUTION_PHASE, "call-llm");
    assert.equal(env.AUX4_ACCESS_TOKEN, "secret-token");
    assert.equal(args[1].includes("secret-token"), false);
    const child = { type: "aux4.timing", traceId: env.AUX4_TRACE_ID, phase: env.AUX4_EXECUTION_PHASE, span: "model.inference", durationMs: 12, status: "ok" };
    childLines.push(JSON.stringify(child), JSON.stringify({ ...child, token: "secret-token" }),
      JSON.stringify({ ...child, span: "secret-question" }), JSON.stringify({ ...child, traceId: "bad" }),
      JSON.stringify({ ...child, durationMs: -1 }), "secret-stderr");
    return { exitCode: 0, stdout: '{"status":"final","text":"secret-output"}', stderr: childLines.join("\n") };
  };
  const output = await handleExecutionEvent(f.event, f.options);
  assert.deepEqual(output, { status: "final", text: "secret-output" });
  assert.deepEqual(f.lines.map(line => line.span), ["sync.pre", "grant.cache", "grant.fetch", "command.validation", "model.inference", "command.execution", "sync.post", "completion", "phase.total"]);
  assert.deepEqual(f.order, ["pre", "fetch", "post", "completion"]);
  const serialized = JSON.stringify(f.lines);
  for (const secret of [f.event.executionId, "secret-token", "secret-machine-key", "secret-question", "secret-output", "secret-stderr"])
    assert.equal(serialized.includes(secret), false, secret);
  assert.ok(f.lines.every(line => Number.isFinite(line.durationMs) && line.durationMs >= 0 && line.status === "ok"));
});

test("correlation overrides are restricted and failures still close their timing spans", async t => {
  const f = fixture(t);
  const traceId = "0123456789abcdef0123456789abcdef";
  await handleExecutionEvent({ ...f.event, traceId }, f.options);
  assert.ok(f.lines.every(line => line.traceId === traceId));
  f.lines.length = 0;
  let header;
  global.fetch = async (url, options) => {
    header = options.headers["X-Aux4-Trace-Id"];
    return { ok: true, json: async () => grant() };
  };
  await handleExecutionEvent({ ...f.event, executionId: `${f.event.executionId}-header`, headers: { "x-Aux4-trace-id": traceId } }, f.options);
  assert.equal(header, traceId);
  assert.ok(f.lines.every(line => line.traceId === traceId));
  f.lines.length = 0;
  await handleExecutionEvent({ ...f.event, traceId: [traceId] }, f.options);
  assert.ok(f.lines.every(line => typeof line.traceId === "string" && line.traceId !== traceId));
  f.lines.length = 0;
  await assert.rejects(handleExecutionEvent({ ...f.event, traceId: "secret-token" }, {
    ...f.options, runHook: () => { throw new Error("secret-error-detail"); }
  }), /secret-error-detail/);
  assert.deepEqual(f.lines.map(line => [line.span, line.status]), [["sync.pre", "error"], ["phase.total", "error"]]);
  assert.equal(JSON.stringify(f.lines).includes("secret"), false);
});
