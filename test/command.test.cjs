const test = require("node:test");
const assert = require("node:assert/strict");
const Command = require("../lib/Command");

test("executeFile rejects an oversized single argument with an actionable message", async () => {
  // One argument larger than the Linux single-argument execve limit would make
  // execve fail with a raw E2BIG. It must be rejected cleanly instead.
  const huge = "x".repeat(Command.MAX_ARG_STRLEN + 1);
  const result = await Command.executeFile("node", ["-e", "process.exit(0)", huge]);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /too large to spawn/);
  assert.match(result.stderr, /via a file or stdin, not argv/);
});

test("executeFile rejects when the total argv+env block exceeds the budget", async () => {
  // Spread the payload across many arguments (each under the per-argument cap)
  // so it is the aggregate total that trips the guard.
  const chunk = "y".repeat(64 * 1024);
  const args = ["-e", "process.exit(0)"];
  for (let i = 0; i < 20; i++) args.push(chunk); // ~1.25 MiB total
  const result = await Command.executeFile("node", args);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /too large to spawn/);
  assert.match(result.stderr, /via a file or stdin, not argv/);
});

test("executeFile still runs a normal-sized command", async () => {
  const result = await Command.executeFile("node", ["-e", "process.stdout.write('ok')"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok");
});

test("argvEnvSize measures the largest argument and the total argv+env bytes", () => {
  const { total, maxArg } = Command.argvEnvSize("node", ["-e", "abcd"], { FOO: "bar" });

  // "node\0" + "-e\0" + "abcd\0" = 5 + 3 + 5 = 13; env "FOO"+"bar"+2 = 8.
  assert.equal(maxArg, 4);
  assert.equal(total, 13 + 8);
});
