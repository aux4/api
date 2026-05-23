const crypto = require("crypto");

class AuthHandler {
  constructor(config, commandPool, defaultTimeout) {
    this.auth = config.security?.auth;
    this.commandPool = commandPool;
    this.defaultTimeout = defaultTimeout;
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

    return this.authenticateToken(request, authType);
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

    try {
      const cookiesJson = JSON.stringify(request.cookies || {});
      const headersJson = JSON.stringify(request.headers);
      const command = `${this.auth.command} --cookies '${escape(cookiesJson)}' --headers '${escape(headersJson)}'`;

      const { exitCode, stdout } = await this.commandPool.execute(command, null, this.defaultTimeout);

      if (exitCode !== 0) {
        return { error: "Authentication failed" };
      }

      const output = stdout.trim();
      let principal = null;
      if (output) {
        try { principal = JSON.parse(output); } catch {}
      }

      return { principal };
    } catch {
      return { error: "Authentication failed" };
    }
  }

  async authenticateWithCookie(request, cookieName, cookieValue) {
    if (!this.auth?.command) return null;

    const cookies = { ...(request.cookies || {}), [cookieName]: cookieValue };
    const command = `${this.auth.command} --cookies '${escape(JSON.stringify(cookies))}' --headers '${escape(JSON.stringify(request.headers))}'`;

    try {
      const { exitCode, stdout } = await this.commandPool.execute(command, null, this.defaultTimeout);
      if (exitCode === 0) {
        try { return JSON.parse(stdout.trim()); } catch {}
      }
    } catch {}

    return null;
  }
}

function escape(str) {
  return str.replace(/[\r\n]/g, " ").replace(/'/g, "'\\''");
}

module.exports = AuthHandler;
