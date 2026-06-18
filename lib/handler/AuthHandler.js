const crypto = require("crypto");
const SessionToken = require("./SessionToken");

const DEFAULT_CACHE_TTL = 60000; // 1 minute

class AuthHandler {
  constructor(config, commandPool, defaultTimeout) {
    this.auth = config.security?.auth;
    this.commandPool = commandPool;
    this.defaultTimeout = defaultTimeout;
    this.cache = new Map();
    this.cacheTTL = config.security?.auth?.cacheTTL || DEFAULT_CACHE_TTL;
  }

  get enabled() {
    return !!this.auth;
  }

  async authenticate(request) {
    if (!this.auth) return { principal: null };

    const authType = this.auth.type || "both";

    if (authType === "apiKey") {
      return this.authenticateApiKey(request);
    }

    if (authType === "oauth") {
      return this.authenticateSession(request);
    }

    return this.authenticateToken(request, authType);
  }

  // Per-request auth for type:oauth — verifies the session JWT cookie in-process
  // (no subprocess). Missing/invalid/expired -> error (401).
  authenticateSession(request) {
    const session = this.auth.session || {};
    const cookieName = session.cookie || "auth_token";
    const secret = session.secret;

    const token = (request.cookies || {})[cookieName] || null;
    if (!token) {
      return { error: "Authentication required" };
    }

    const principal = SessionToken.verify(token, secret);
    if (!principal) {
      return { error: "Authentication failed" };
    }

    // Strip JWT housekeeping claims from the injected principal.
    const { iat, exp, ...rest } = principal;
    return { principal: rest };
  }

  authenticateApiKey(request) {
    const headerName = (this.auth.header || "X-API-Key").toLowerCase();
    const provided = request.headers[headerName] || "";
    const expected = this.auth.apiKey || "";

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);

    if (!provided || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { error: "Invalid or missing API key" };
    }

    return { principal: null };
  }

  async authenticateToken(request, authType) {
    if (!this.auth.command) return { principal: null };

    let token = null;

    if (authType === "cookie" || authType === "both") {
      const cookieName = this.auth.cookie || "auth_token";
      token = (request.cookies || {})[cookieName] || null;
    }

    if (!token && (authType === "bearer" || authType === "both")) {
      const authHeader = request.headers.authorization || "";
      if (authHeader.startsWith("Bearer ")) {
        token = authHeader.substring(7);
      }
    }

    if (!token) {
      return { error: "Authentication required" };
    }

    // Check cache
    const cached = this.cache.get(token);
    if (cached && Date.now() - cached.time < this.cacheTTL) {
      return cached.result;
    }

    try {
      const cookiesJson = JSON.stringify(request.cookies || {});
      const headersJson = JSON.stringify(request.headers);
      const command = `${this.auth.command} --cookies '${escape(cookiesJson)}' --headers '${escape(headersJson)}'`;

      const { exitCode, stdout } = await this.commandPool.execute(command, null, this.defaultTimeout);

      if (exitCode !== 0) {
        const result = { error: "Authentication failed" };
        this.cache.set(token, { result, time: Date.now() });
        return result;
      }

      const output = stdout.trim();
      let principal = null;
      if (output) {
        try { principal = JSON.parse(output); } catch {}
      }

      const result = { principal };
      this.cache.set(token, { result, time: Date.now() });
      return result;
    } catch {
      return { error: "Authentication failed" };
    }
  }

  async authenticateWithCookie(request, cookieName, cookieValue) {
    if (!this.auth?.command) return null;

    // Check cache
    const cached = this.cache.get(cookieValue);
    if (cached && Date.now() - cached.time < this.cacheTTL && cached.result.principal) {
      return cached.result.principal;
    }

    const cookies = { ...(request.cookies || {}), [cookieName]: cookieValue };
    const command = `${this.auth.command} --cookies '${escape(JSON.stringify(cookies))}' --headers '${escape(JSON.stringify(request.headers))}'`;

    try {
      const { exitCode, stdout } = await this.commandPool.execute(command, null, this.defaultTimeout);
      if (exitCode === 0) {
        const principal = JSON.parse(stdout.trim());
        this.cache.set(cookieValue, { result: { principal }, time: Date.now() });
        return principal;
      }
    } catch {}

    return null;
  }

  invalidate(token) {
    this.cache.delete(token);
  }
}

function escape(str) {
  return str.replace(/[\r\n]/g, " ").replace(/'/g, "'\\''");
}

module.exports = AuthHandler;
