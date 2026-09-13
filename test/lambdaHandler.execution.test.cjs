const test = require("node:test");
const assert = require("node:assert/strict");
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
  Command.executeFile = async (...args) => {
    invoked = args;
    return { exitCode: 0, stdout: '{"status":"final","text":"done"}', stderr: "" };
  };

  const output = await handleExecutionEvent({
    version: "aux4.execution.v1",
    executionId: "00abc1234_00000000-0000-4000-8000-000000000001",
    command: ["agent-manager", "kb", "orchestrate", "call-llm"],
    params: { message: "hello" }
  });

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
  assert.equal(
    requests[1].url,
    "https://dev.api.aux4.cloud/v1/executions/00abc1234_00000000-0000-4000-8000-000000000001/complete"
  );
});
