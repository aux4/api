const assert = require("node:assert");
const test = require("node:test");

const { resolveExpiresAt } = require("../lib/handler/AuthHandler");

test("session token renewal", async (t) => {
  const now = () => Math.floor(Date.now() / 1000);

  await t.test("uses the provider's expires_in when given", () => {
    assert.ok(Math.abs(resolveExpiresAt(900, null) - (now() + 900)) <= 1);
  });

  await t.test("falls back to the JWT exp claim", () => {
    const exp = now() + 1234;
    const jwt = `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.y`;
    assert.equal(resolveExpiresAt(0, jwt), exp);
  });

  // The regression that pinned a long-lived session to one dead token: a 0 here
  // is falsy, and shouldRefresh/isExpired both tested `!!oauth.expiresAt`, so an
  // unknown expiry disabled renewal for the rest of the session.
  await t.test("never returns a falsy expiry when the expiry is unknown", () => {
    const opaque = resolveExpiresAt(undefined, "opaque-token-not-a-jwt");
    assert.ok(opaque > now(), "unknown expiry must still schedule a future re-check");
    assert.ok(opaque <= now() + 300);
  });

  await t.test("ignores an already-expired exp claim rather than trusting it", () => {
    const jwt = `x.${Buffer.from(JSON.stringify({ exp: now() - 10 })).toString("base64url")}.y`;
    assert.ok(resolveExpiresAt(0, jwt) > now());
  });
});
