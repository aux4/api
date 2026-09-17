const crypto = require("crypto");
const SessionToken = require("./SessionToken");
const { relayRequestTimings } = require("../ExecutionTiming");

const DEFAULT_CACHE_TTL = 60000; // 1 minute
const DEFAULT_REFRESH_SKEW = 60; // refresh one minute before access-token expiry

class AuthHandler {
  constructor(config, commandPool, defaultTimeout, moduleRegistry) {
    this.auth = config.security?.auth;
    this.commandPool = commandPool;
    this.defaultTimeout = defaultTimeout;
    this.cache = new Map();
    this.cacheTTL = config.security?.auth?.cacheTTL || DEFAULT_CACHE_TTL;
    this.production = !!config.production;
    this.refreshSkew = config.security?.auth?.session?.refreshSkew ?? DEFAULT_REFRESH_SKEW;
    // type:oauth sessions exist to delegate the signed-in user's access token to
    // route commands (AUX4_ACCESS_TOKEN). A session that cannot supply that token —
    // a legacy identity-only cookie minted before the sealed-envelope format (no
    // __oauth) — must NOT be accepted as if it were fine: the route would spawn with
    // no token and fail deep in a subprocess with no signal. Default to forcing
    // re-auth. An oauth app whose routes genuinely need no delegated token can opt
    // out with `security.auth.session.requireDelegation: false`.
    this.requireDelegation = config.security?.auth?.session?.requireDelegation !== false;
    this.moduleRegistry = moduleRegistry;
  }

  async prepare() {
    if (this.enabled && this.auth?.handler && this.moduleRegistry) {
      await this.moduleRegistry.prepare(this.auth.handler, "auth:validator");
    }
  }

  // A deploy-time kill switch: config `security.auth.disableWhenEnv: SOME_ENV`
  // turns auth OFF entirely when that env var is "true". Lets one image ship as
  // either a secured or a fully-open service (e.g. an OAuth broker) without editing
  // config.yaml — a token-less caller is then allowed instead of 401'd, because the
  // validate command never runs when auth is disabled.
  get disabledByEnv() {
    const key = this.auth && this.auth.disableWhenEnv;
    return !!key && String(process.env[key]).toLowerCase() === "true";
  }

  get enabled() {
    return !!this.auth && !this.disabledByEnv;
  }

  async authenticate(request, reply) {
    if (!this.auth || this.disabledByEnv) return { principal: null };

    const authType = this.auth.type || "both";

    if (authType === "apiKey") {
      return this.authenticateApiKey(request);
    }

    if (authType === "oauth") {
      return this.authenticateSession(request, reply);
    }

    return this.authenticateToken(request, authType);
  }

  // Per-request auth for type:oauth — opens the encrypted session in-process.
  // Missing/invalid/expired -> error (401). Refresh uses the installed oauth
  // package only when the access token is near expiry.
  async authenticateSession(request, reply) {
    const session = this.auth.session || {};
    const cookieName = session.cookie || "auth_token";
    const secret = session.secret;

    const token = (request.cookies || {})[cookieName] || null;
    if (!token) {
      return { error: "Authentication required" };
    }

    // New sessions are opaque encrypted envelopes. Keep accepting the older
    // signed identity-only JWT until its existing TTL expires.
    const sessionClaims = SessionToken.unseal(token, secret) || SessionToken.verify(token, secret);
    if (!sessionClaims) {
      return { error: "Authentication failed" };
    }

    const { iat, exp, __oauth, ...rest } = sessionClaims;
    let oauth = __oauth;

    if (oauth && this.shouldRefresh(oauth)) {
      if (!oauth.refreshToken) {
        if (this.isExpired(oauth)) return { error: "Authentication required" };
      } else {
        const refreshed = await this.refreshOAuth(oauth);
        if (refreshed) {
          oauth = refreshed;
          this.rotateSessionCookie(reply, { ...rest, __oauth: oauth }, exp);
        } else if (this.isExpired(oauth)) {
          return { error: "Authentication required" };
        }
      }
    }

    // Scope gate: when `requiredScope` is configured, the authenticated user must
    // carry it in their `scopes` claim (populated from SSO userinfo). This enforces
    // "only users with access to this scope" for a browser session. A 403 (not 401)
    // so it is NOT treated as unauthenticated and redirected back into a login loop.
    const required = this.auth.requiredScope;
    if (required) {
      const scopes = Array.isArray(rest.scopes) ? rest.scopes : [];
      if (!scopes.includes(required)) {
        return { error: "You do not have access to this scope", status: 403 };
      }
    }

    const executionEnv = oauth?.accessToken
      ? { AUX4_ACCESS_TOKEN: oauth.accessToken }
      : undefined;

    // No delegated token available (legacy identity-only cookie, or a sealed session
    // whose OAuth credentials could not be recovered/refreshed). Rather than silently
    // continue and let the route command crash without AUX4_ACCESS_TOKEN, force a
    // clean re-authentication so the caller is redirected to sign in again.
    if (!executionEnv && this.requireDelegation) {
      return { error: "Authentication required" };
    }

    return { principal: rest, executionEnv };
  }

  shouldRefresh(oauth) {
    return !!oauth.expiresAt && Math.floor(Date.now() / 1000) + this.refreshSkew >= oauth.expiresAt;
  }

  isExpired(oauth) {
    return !!oauth.expiresAt && Math.floor(Date.now() / 1000) >= oauth.expiresAt;
  }

  async refreshOAuth(oauth) {
    const provider = this.auth.providers?.[oauth.provider];
    if (!provider) return null;

    const args = [
      "aux4", "oauth", "refresh",
      "--provider", oauth.provider,
      "--clientId", provider.clientId,
      "--refreshToken", oauth.refreshToken
    ];
    if (provider.clientSecret) args.push("--clientSecret", provider.clientSecret);
    if (provider.tokenUrl) args.push("--tokenUrl", provider.tokenUrl);
    if (provider.clientSecretIn) args.push("--clientSecretIn", provider.clientSecretIn);

    try {
      const command = args.map(shellQuote).join(" ");
      const { exitCode, stdout } = await this.commandPool.execute(command, null, this.defaultTimeout);
      if (exitCode !== 0) return null;
      const result = JSON.parse(stdout.trim());
      if (!result.accessToken) return null;
      const expiresIn = Number(result.expiresIn || 0);
      return {
        provider: oauth.provider,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken || oauth.refreshToken,
        expiresAt: expiresIn > 0 ? Math.floor(Date.now() / 1000) + expiresIn : 0
      };
    } catch {
      return null;
    }
  }

  rotateSessionCookie(reply, claims, absoluteExpiry) {
    if (!reply?.setCookie) return;
    const session = this.auth.session || {};
    const configuredTtl = session.ttl || 86400;
    const remainingTtl = absoluteExpiry
      ? Math.max(1, absoluteExpiry - Math.floor(Date.now() / 1000))
      : configuredTtl;
    const ttl = Math.min(configuredTtl, remainingTtl);
    reply.setCookie(session.cookie || "auth_token", SessionToken.seal(claims, session.secret, ttl), {
      httpOnly: true,
      sameSite: "lax",
      secure: this.production,
      path: "/",
      maxAge: ttl
    });
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
    if (!this.auth.command && !this.auth.handler) return { principal: null };

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
      const { exitCode, stdout, stderr } = await this.runValidator(request);
      relayRequestTimings(request.headers, stderr);

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
      if (this.auth.handler && (!principal || typeof principal !== "object" || Array.isArray(principal))) {
        return { error: "Authentication failed" };
      }

      const result = {
        principal,
        executionEnv: authType === "bearer" || (authType === "both" && request.headers.authorization?.startsWith("Bearer "))
          ? { AUX4_ACCESS_TOKEN: token }
          : undefined
      };
      this.cache.set(token, { result, time: Date.now() });
      return result;
    } catch {
      return { error: "Authentication failed" };
    }
  }

  async authenticateWithCookie(request, cookieName, cookieValue) {
    if (!this.auth?.command && !this.auth?.handler) return null;

    // Check cache
    const cached = this.cache.get(cookieValue);
    if (cached && Date.now() - cached.time < this.cacheTTL && cached.result.principal) {
      return cached.result.principal;
    }

    const cookies = { ...(request.cookies || {}), [cookieName]: cookieValue };
    const authRequest = { ...request, cookies };

    try {
      const { exitCode, stdout, stderr } = await this.runValidator(authRequest);
      relayRequestTimings(request.headers, stderr);
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

  runValidator(request) {
    if (this.auth.handler) {
      if (!this.moduleRegistry) throw new Error("In-process auth handler registry is not configured");
      const event = {
        headers: { ...(request.headers || {}) },
        cookies: { ...(request.cookies || {}) },
        requestContext: { requestId: request.uuid, identity: { sourceIp: request.ip } }
      };
      return this.moduleRegistry.execute(
        this.auth.handler,
        "auth:validator",
        { method: "AUTH", url: request.url || "/", ...request },
        {},
        event,
        null,
        undefined,
        this.defaultTimeout
      );
    }

    const cookiesJson = JSON.stringify(request.cookies || {});
    const headersJson = JSON.stringify(request.headers || {});
    const command = `${this.auth.command} --cookies '${escape(cookiesJson)}' --headers '${escape(headersJson)}'`;
    return this.commandPool.execute(command, null, this.defaultTimeout);
  }
}

function escape(str) {
  return str.replace(/[\r\n]/g, " ").replace(/'/g, "'\\''");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

module.exports = AuthHandler;
