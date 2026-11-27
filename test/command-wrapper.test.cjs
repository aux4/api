const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Command = require("../lib/Command");

let directory;
let wrapper;
let previous;

test.before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "aux4-api-wrapper-"));
  wrapper = path.join(directory, "wrapper.sh");
  await fs.writeFile(wrapper, "#!/bin/sh\nset -eu\n[ \"${1:-}\" = -- ] && shift\nexport BINDING_ONLY=child-value\nexec \"$@\"\n");
  await fs.chmod(wrapper, 0o755);
  previous = process.env.AUX4_COMMAND_WRAPPER;
  process.env.AUX4_COMMAND_WRAPPER = wrapper;
});

test.after(async () => {
  if (previous === undefined) delete process.env.AUX4_COMMAND_WRAPPER;
  else process.env.AUX4_COMMAND_WRAPPER = previous;
  await fs.rm(directory, { recursive: true, force: true });
});

test("execute resolves bindings in the child only", async () => {
  const result = await Command.execute(
    `node -e "process.stdout.write(process.env.BINDING_ONLY || 'missing')"`,
    null,
    2000
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "child-value");
  assert.equal(process.env.BINDING_ONLY, undefined);
});

test("execute preserves shell metacharacters as command data", async () => {
  const value = "quote ' ; echo injected";
  const result = await Command.execute(
    `node -e "process.stdout.write(process.argv[1])" ${JSON.stringify(value)}`,
    null,
    2000
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, value);
});

test("stream and openStream use the child wrapper", async () => {
  for (const spawn of [
    () => Command.stream(`node -e "process.stdout.write(process.env.BINDING_ONLY || 'missing')"`, null, 2000),
    () => Command.openStream(`node -e "process.stdout.write(process.env.BINDING_ONLY || 'missing')"`, 2000)
  ]) {
    const child = spawn();
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
    });
    assert.equal(output, "child-value");
  }
});

test("executeFile uses the wrapper without changing argv semantics", async () => {
  const result = await Command.executeFile(
    process.execPath,
    ["-e", "process.stdout.write(process.env.BINDING_ONLY || 'missing')"],
    null,
    2000
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "child-value");
});

test("malformed wrapper configuration fails closed", async () => {
  const valid = process.env.AUX4_COMMAND_WRAPPER;
  process.env.AUX4_COMMAND_WRAPPER = "sh -c evil";
  await assert.rejects(Command.execute("true", null, 2000), /Invalid AUX4_COMMAND_WRAPPER/);
  process.env.AUX4_COMMAND_WRAPPER = valid;
});

test("timeouts still terminate wrapped commands", async () => {
  const result = await Command.execute("node -e 'setTimeout(() => {}, 5000)'", null, 25);
  assert.equal(result.exitCode, 1);
});
