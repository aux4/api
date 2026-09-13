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

function deriveKey(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest();
}

/**
 * Encrypt an entire session into an opaque AES-256-GCM cookie. Keeping the
 * identity and OAuth credentials in one encrypted envelope avoids the size and
 * information leak of nesting encrypted credentials inside a readable JWT.
 */
function seal(payload, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { ...payload, iat: now };
  if (ttlSeconds && ttlSeconds > 0) claims.exp = now + Math.floor(ttlSeconds);

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  cipher.setAAD(Buffer.from("aux4-session-v1", "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(claims), "utf8"),
    cipher.final()
  ]);
  return `v1.${base64urlEncode(Buffer.concat([iv, cipher.getAuthTag(), ciphertext]))}`;
}

function unseal(token, secret) {
  try {
    if (!token || typeof token !== "string" || !token.startsWith("v1.")) return null;
    const raw = base64urlDecode(token.substring(3));
    if (raw.length < 29) return null;

    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(secret), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from("aux4-session-v1", "utf8"));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plaintext = Buffer.concat([
      decipher.update(raw.subarray(28)),
      decipher.final()
    ]);
    const payload = JSON.parse(plaintext.toString("utf8"));
    if (!payload || typeof payload !== "object") return null;
    if (payload.exp !== undefined && Math.floor(Date.now() / 1000) >= payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = { sign, verify, seal, unseal, base64urlEncode, base64urlDecode };
