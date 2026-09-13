const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Command = require("../lib/Command");
const {
  assertAuthorizedCommand,
  commandArgs,
  handleExecutionEvent
} = require("../lib/lambdaHandler");

test("structured execution rejects shell-shaped command segments", () => {
  assert.throws(
    () => commandArgs({ command: ["agent-manager", "kb; id"] }),
    /invalid command segment/
  );
});

test("structured execution command must stay under its authorized prefix", () => {
  assert.doesNotThrow(() => assertAuthorizedCommand(
    ["agent-manager", "kb", "orchestrate", "call-llm"],
    "agent-manager kb orchestrate"
  ));
  assert.throws(
    () => assertAuthorizedCommand(
      ["agent-manager", "other-agent", "orchestrate", "call-llm"],
      "agent-manager kb orchestrate"
    ),
    /not authorized/
  );
});

test("execution id is exchanged and the access token stays in child env", async t => {
  const originalFetch = global.fetch;
  const originalExecuteFile = Command.executeFile;
  const originalEnv = { ...process.env };
  t.after(() => {
    global.fetch = originalFetch;
    Command.executeFile = originalExecuteFile;
    process.env = originalEnv;
  });

  process.env.AUX4_CLOUD_API_URL = "https://dev.api.aux4.cloud";
  process.env.CLOUD_SYNC_TOKEN = "machine-key";
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        accessToken: "delegated-token",
        command: "agent-manager kb orchestrate"
      })
    };
  };
  let invoked;
  const phases = [];
  Command.executeFile = async (...args) => {
    phases.push("command");
    invoked = args;
    return { exitCode: 0, stdout: '{"status":"final","text":"done"}', stderr: "" };
  };

  const output = await handleExecutionEvent({
    version: "aux4.execution.v1",
    executionId: "00abc1234_00000000-0000-4000-8000-000000000001",
    command: ["agent-manager", "kb", "orchestrate", "call-llm"],
    params: { message: "hello" }
  }, { runHook: async phase => phases.push(phase) });

  assert.equal(
    requests[0].url,
    "https://dev.api.aux4.cloud/v1/executions/00abc1234_00000000-0000-4000-8000-000000000001/token"
  );
  assert.equal(requests[0].options.headers.Authorization, "Bearer machine-key");
  assert.deepEqual(invoked.slice(0, 2), [
    "aux4",
    ["agent-manager", "kb", "orchestrate", "call-llm", "--message", "hello"]
  ]);
  assert.equal(invoked[4].AUX4_ACCESS_TOKEN, "delegated-token");
  assert.deepEqual(output, { status: "final", text: "done" });
  assert.deepEqual(phases, ["pre", "command", "post"]);
  assert.equal(
    requests[1].url,
    "https://dev.api.aux4.cloud/v1/executions/00abc1234_00000000-0000-4000-8000-000000000001/complete"
  );
});

test("execution state is pushed before a final grant is completed", async t => {
  const originalFetch = global.fetch;
  const originalExecuteFile = Command.executeFile;
  const originalEnv = { ...process.env };
  t.after(() => {
    global.fetch = originalFetch;
    Command.executeFile = originalExecuteFile;
    process.env = originalEnv;
  });

  process.env.AUX4_CLOUD_API_URL = "https://dev.api.aux4.cloud";
  process.env.CLOUD_SYNC_TOKEN = "machine-key";
  const order = [];
  global.fetch = async url => {
    if (url.endsWith("/token")) {
      return {
        ok: true,
        json: async () => ({
          accessToken: "delegated-token",
          command: "agent-manager kb orchestrate"
        })
      };
    }
    order.push("complete");
    return { ok: true };
  };
  Command.executeFile = async () => ({
    exitCode: 0,
    stdout: '{"status":"final","text":"done"}',
    stderr: ""
  });

  await handleExecutionEvent({
    version: "aux4.execution.v1",
    executionId: "00abc1234_00000000-0000-4000-8000-000000000002",
    command: ["agent-manager", "kb", "orchestrate", "apply-results"]
  }, {
    runHook: async phase => order.push(phase)
  });

  assert.deepEqual(order, ["pre", "post", "complete"]);
});

test("execution hook failure prevents an execution phase from running", async t => {
  const originalExecuteFile = Command.executeFile;
  t.after(() => { Command.executeFile = originalExecuteFile; });
  let invoked = false;
  Command.executeFile = async () => {
    invoked = true;
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  await assert.rejects(
    handleExecutionEvent({
      version: "aux4.execution.v1",
      executionId: "00abc1234_00000000-0000-4000-8000-000000000003",
      command: ["agent-manager", "kb", "orchestrate", "call-llm"]
    }, {
      runHook: async phase => {
        if (phase === "pre") throw new Error("state pull failed");
      }
    }),
    /state pull failed/
  );
  assert.equal(invoked, false);
});

test("structured execution uses the cloud file sync in-process entry points", async t => {
  const originalFetch = global.fetch;
  const originalExecuteFile = Command.executeFile;
  const originalCalls = globalThis.__aux4ExecutionSyncCalls;
  const originalEnv = { ...process.env };
  t.after(() => {
    global.fetch = originalFetch;
    Command.executeFile = originalExecuteFile;
    globalThis.__aux4ExecutionSyncCalls = originalCalls;
    process.env = originalEnv;
  });

  process.env.AUX4_CLOUD_API_URL = "https://dev.api.aux4.cloud";
  process.env.CLOUD_SYNC_TOKEN = "machine-key";
  process.env.AUX4_LAMBDA_EXECUTION_SYNC_MODULE = path.join(
    __dirname,
    "fixtures",
    "execution-sync.mjs"
  );
  delete process.env.AUX4_LAMBDA_EXECUTION_PRE_INVOKE;
  delete process.env.AUX4_LAMBDA_EXECUTION_POST_INVOKE;
  globalThis.__aux4ExecutionSyncCalls = [];

  global.fetch = async url => {
    if (url.endsWith("/token")) {
      return {
        ok: true,
        json: async () => ({
          accessToken: "delegated-token",
          command: "agent-manager kb orchestrate"
        })
      };
    }
    return { ok: true };
  };
  Command.executeFile = async () => ({
    exitCode: 0,
    stdout: '{"status":"final","text":"done"}',
    stderr: ""
  });

  const traceId = "abcdef0123456789abcdef0123456789";
  await handleExecutionEvent({
    version: "aux4.execution.v1",
    executionId: "00abc1234_00000000-0000-4000-8000-000000000004",
    traceId,
    command: ["agent-manager", "kb", "orchestrate", "call-llm"]
  });

  assert.deepEqual(globalThis.__aux4ExecutionSyncCalls, [
    { operation: "pull", traceId },
    { operation: "push", traceId }
  ]);
});
