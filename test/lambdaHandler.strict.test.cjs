const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const packageDir = path.resolve(__dirname, "..");
const syncModule = path.join(__dirname, "fixtures", "strict-loop-sync.mjs");

function startRuntime(events, orderFile) {
  let index = 0;
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url.endsWith("/invocation/next")) {
      const event = events[index++];
      if (!event) return response.end();
      response.setHeader("lambda-runtime-aws-request-id", `strict-${index}`);
      response.end(JSON.stringify(event));
      return;
    }
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      fs.appendFileSync(orderFile, `${request.url.endsWith("/error") ? "error" : "resp"}\n`);
      response.statusCode = 202;
      response.end("{}");
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function runLoop({ events, mode, stateEnabled, config = { api: {} }, maxInvocations = events.length, artifact = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aux4-api-strict-"));
  const orderFile = path.join(dir, "order.log");
  const runtime = await startRuntime(events, orderFile);
  const address = runtime.address();
  const childArgs = artifact
    ? ["package/lib/server.js", "lambda-loop", "", JSON.stringify(config.api || {})]
    : ["-e", `require('./lib/lambdaHandler').lambdaLoop(${JSON.stringify(config)})`];
  const child = spawn(process.execPath, childArgs, {
    cwd: packageDir,
    env: {
      ...process.env,
      AWS_LAMBDA_RUNTIME_API: `127.0.0.1:${address.port}`,
      AUX4_API_NO_COMMAND_DAEMON: "1",
      AUX4_LAMBDA_MAX_INVOCATIONS: String(maxInvocations),
      AUX4_LAMBDA_STATE_SYNC_REQUIRED: "true",
      AUX4_LAMBDA_PRE_INVOKE_MODULE: syncModule,
      AUX4_LAMBDA_POST_INVOKE_MODULE: syncModule,
      STRICT_ORDER_FILE: orderFile,
      STRICT_SYNC_MODE: mode || "",
      ...(stateEnabled === undefined ? {} : { CLOUD_STATE_ENABLED: stateEnabled })
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(String(chunk)));
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`strict lambda loop timed out: ${stderr.join("")}`));
    }, 10000);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  await new Promise(resolve => runtime.close(resolve));
  return { order: fs.readFileSync(orderFile, "utf8").trim().split("\n").filter(Boolean), exit };
}

const http404 = pathName => ({
  httpMethod: "GET",
  path: pathName,
  pathParameters: { proxy: pathName.replace(/^\//, "") },
  headers: {},
  body: null,
  isBase64Encoded: false,
  requestContext: { identity: { sourceIp: "127.0.0.1" } }
});

test("strict ordinary HTTP barrier orders pull, handler response, push", async () => {
  const result = await runLoop({ events: [http404("/custom/mutate")] });
  assert.deepEqual(result.order, ["pull", "push", "resp"]);
  assert.equal(result.exit.code, 0);
});

test("strict pull failure blocks handler and push, then retries next invocation", async () => {
  const result = await runLoop({
    events: [http404("/custom/mutate"), http404("/custom/mutate")],
    mode: "fail-once",
    maxInvocations: 2
  });
  assert.deepEqual(result.order, ["pull", "error", "pull", "push", "resp"]);
});

test("strict incomplete pull blocks handler and reports invocation error", async () => {
  const result = await runLoop({ events: [http404("/action/mutate")], mode: "incomplete" });
  assert.deepEqual(result.order, ["pull", "error"]);
});

test("strict rejects contradictory explicit false result flags", async () => {
  const pre = await runLoop({ events: [http404("/custom/mutate")], mode: "pre-ok-false" });
  assert.deepEqual(pre.order, ["pull", "error"]);

  const post = await runLoop({ events: [http404("/custom/mutate")], mode: "post-ok-false" });
  assert.deepEqual(post.order, ["pull", "push", "error"]);
});

test("strict push failure reports invocation error instead of success", async () => {
  const result = await runLoop({ events: [http404("/custom/mutate")], mode: "push-fail" });
  assert.deepEqual(result.order, ["pull", "push", "error"]);
});

test("strict mode accepts an explicitly disabled stateless sync wrapper", async () => {
  const result = await runLoop({ events: [http404("/custom/stateless")], stateEnabled: "false" });
  assert.deepEqual(result.order, ["pull", "push", "resp"]);
});

test("strict WebSocket dispatch keeps the pull/push barrier", async () => {
  const result = await runLoop({
    config: { api: {}, ws: {} },
    events: [{ requestContext: { connectionId: "c-1", eventType: "MESSAGE", routeKey: "$default" }, body: "{}" }]
  });
  assert.deepEqual(result.order, ["pull", "push", "resp"]);
});

test("strict mode requires both valid module hooks before app construction", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aux4-api-strict-missing-"));
  const runtime = await startRuntime([http404("/custom/mutate")], path.join(dir, "order.log"));
  const address = runtime.address();
  const child = spawn(process.execPath, ["-e", "require('./lib/lambdaHandler').lambdaLoop({ api: {} })"], {
    cwd: packageDir,
    env: { ...process.env, AWS_LAMBDA_RUNTIME_API: `127.0.0.1:${address.port}`, AUX4_API_NO_COMMAND_DAEMON: "1", AUX4_LAMBDA_MAX_INVOCATIONS: "1", AUX4_LAMBDA_STATE_SYNC_REQUIRED: "true", AUX4_LAMBDA_PRE_INVOKE_MODULE: syncModule, AUX4_LAMBDA_POST_INVOKE_MODULE: path.join(dir, "missing.mjs"), STRICT_ORDER_FILE: path.join(dir, "order.log") },
    stdio: "ignore"
  });
  const exit = await new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  await new Promise(resolve => runtime.close(resolve));
  assert.equal(exit.code, 0);
  assert.deepEqual(fs.readFileSync(path.join(dir, "order.log"), "utf8").trim(), "error");
});

test("bundled package CLI enforces strict success, failures, and bounded retry", async () => {
  const success = await runLoop({ artifact: true, events: [http404("/custom/mutate")] });
  assert.deepEqual(success.order, ["pull", "push", "resp"]);

  const pullFailure = await runLoop({ artifact: true, mode: "incomplete", events: [http404("/custom/mutate")] });
  assert.deepEqual(pullFailure.order, ["pull", "error"]);

  const pushFailure = await runLoop({ artifact: true, mode: "push-fail", events: [http404("/custom/mutate")] });
  assert.deepEqual(pushFailure.order, ["pull", "push", "error"]);

  const falseFlag = await runLoop({ artifact: true, mode: "post-ok-false", events: [http404("/custom/mutate")] });
  assert.deepEqual(falseFlag.order, ["pull", "push", "error"]);

  const retry = await runLoop({
    artifact: true,
    mode: "fail-once",
    events: [http404("/custom/mutate"), http404("/custom/mutate")],
    maxInvocations: 2
  });
  assert.deepEqual(retry.order, ["pull", "error", "pull", "push", "resp"]);
});
