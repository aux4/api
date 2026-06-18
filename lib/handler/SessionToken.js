const crypto = require("crypto");

function base64urlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str) {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

/**
 * Mint a compact HS256 JWT. Uses only node `crypto` (no external deps).
 * @param {object} payload claims (an `exp` claim is added from ttlSeconds)
 * @param {string} secret HMAC signing secret
 * @param {number} ttlSeconds lifetime in seconds (added as `exp`)
 * @returns {string} compact JWT (header.payload.signature)
 */
function sign(payload, secret, ttlSeconds) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = { ...payload, iat: now };
  if (ttlSeconds && ttlSeconds > 0) {
    claims.exp = now + Math.floor(ttlSeconds);
  }

  const encodedHeader = base64urlEncode(JSON.stringify(header));
  const encodedPayload = base64urlEncode(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = base64urlEncode(crypto.createHmac("sha256", secret).update(signingInput).digest());

  return `${signingInput}.${signature}`;
}

/**
 * Verify a compact HS256 JWT: checks signature (timing-safe) and `exp`.
 * @param {string} token compact JWT
 * @param {string} secret HMAC signing secret
 * @returns {object|null} the decoded payload, or null if invalid/expired
 */
function verify(token, secret) {
  if (!token || typeof token !== "string") return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, providedSignature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const expectedSignature = base64urlEncode(crypto.createHmac("sha256", secret).update(signingInput).digest());

  const a = Buffer.from(providedSignature);
  const b = Buffer.from(expectedSignature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }

  let header;
  let payload;
  try {
    header = JSON.parse(base64urlDecode(encodedHeader).toString("utf8"));
    payload = JSON.parse(base64urlDecode(encodedPayload).toString("utf8"));
  } catch {
    return null;
  }

  if (!header || header.alg !== "HS256") return null;

  if (payload.exp !== undefined) {
    const now = Math.floor(Date.now() / 1000);
    if (now >= payload.exp) return null;
  }

  return payload;
}

module.exports = { sign, verify, base64urlEncode, base64urlDecode };
