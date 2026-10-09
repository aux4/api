const test = require("node:test");
const assert = require("node:assert/strict");
const RestHandler = require("../lib/handler/RestHandler");
const { CommandPool } = require("../lib/CommandPool");

// buildArgs() embeds request context as flags in a shell command string that
// Command.execute() hands to `/bin/sh -c "<command>"` — the WHOLE string is a
// single execve argv entry, capped at Linux's MAX_ARG_STRLEN (128 KiB). A
// large body (or, in principle, large params/query) must never be embedded in
// that string; it must only ever reach the command via stdin (which
// CommandPool.execute always provides, carrying the full event). This test
// asserts against the actual command-string builder, not an end-to-end spawn,
// so it also catches the regression on macOS dev machines where a single
// argv is not capped at 128 KiB and an E2BIG would never reproduce locally.
function handler() {
  return new RestHandler({}, null, new CommandPool());
}

function request(overrides = {}) {
  return {
    method: "POST",
    url: "/api/echo",
    headers: { host: "localhost", "content-type": "application/json" },
    ...overrides
  };
}

test("buildArgs omits --body from argv when the body exceeds the embedding threshold", () => {
  const rh = handler();
  const oversizedBody = JSON.stringify({ audio: "a".repeat(70 * 1024) }); // ~70 KiB > 64 KiB threshold
  const event = { body: oversizedBody };

  const args = rh.buildArgs(request(), {}, event, null);

  assert.ok(!args.includes("--body"), "argv must not carry an oversized body");
  assert.ok(!args.includes(oversizedBody), "the oversized payload must not appear in the command string at all");
});

test("buildArgs still embeds --body when it is well under the threshold", () => {
  const rh = handler();
  const smallBody = JSON.stringify({ message: "hello" });
  const event = { body: smallBody };

  const args = rh.buildArgs(request(), {}, event, null);

  assert.ok(args.includes("--body"), "a small body must still be embedded in argv");
});

test("buildArgs omits --params when the path parameters exceed the embedding threshold", () => {
  const rh = handler();
  const pathParameters = { blob: "p".repeat(70 * 1024) };

  const args = rh.buildArgs(request(), pathParameters, { body: null }, null);

  assert.ok(!args.includes("--params"), "argv must not carry oversized path parameters");
});

test("buildArgs omits --query when the query string exceeds the embedding threshold", () => {
  const rh = handler();
  const req = request({ url: `/api/echo?blob=${"q".repeat(70 * 1024)}` });

  const args = rh.buildArgs(req, {}, { body: null }, null);

  assert.ok(!args.includes("--query"), "argv must not carry an oversized query string");
});

test("buildArgs stays well under Command.MAX_ARG_STRLEN for a request right at the embedding threshold", () => {
  const Command = require("../lib/Command");
  const rh = handler();
  // Just under the 64 KiB threshold so it IS embedded — confirms the threshold
  // itself leaves headroom below the hard Linux cap used by Command.execute's
  // underlying shell invocation.
  const body = JSON.stringify({ audio: "a".repeat(60 * 1024) });
  const event = { body };

  const args = rh.buildArgs(request(), {}, event, null);

  assert.ok(args.includes("--body"));
  assert.ok(Buffer.byteLength(args) < Command.MAX_ARG_STRLEN);
});
