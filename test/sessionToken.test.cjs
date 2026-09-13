const test = require("node:test");
const assert = require("node:assert/strict");
const SessionToken = require("../lib/handler/SessionToken");

test("sealed OAuth sessions are versioned, opaque, and authenticated", () => {
  const token = SessionToken.seal({
    sub: "user-1",
    __oauth: { accessToken: "access-secret", refreshToken: "refresh-secret" }
  }, "a sufficiently long session secret", 60);

  assert.match(token, /^v1\./);
  assert.equal(token.includes("access-secret"), false);
  assert.equal(token.includes("refresh-secret"), false);
  assert.equal(
    SessionToken.unseal(token, "a sufficiently long session secret").sub,
    "user-1"
  );

  const replacement = token.endsWith("A") ? "B" : "A";
  const tampered = token.slice(0, -1) + replacement;
  assert.equal(SessionToken.unseal(tampered, "a sufficiently long session secret"), null);
  assert.equal(SessionToken.unseal(token, "the wrong secret"), null);
});

test("legacy identity-only session JWTs remain readable during migration", () => {
  const token = SessionToken.sign({ sub: "legacy-user" }, "legacy-secret", 60);
  assert.equal(SessionToken.unseal(token, "legacy-secret"), null);
  assert.equal(SessionToken.verify(token, "legacy-secret").sub, "legacy-user");
});
