const { execFile } = require("child_process");
const SessionToken = require("./SessionToken");
const CookieHandler = require("./CookieHandler");

const TEMP_COOKIE = "auth_oauth_state";
const TEMP_COOKIE_TTL = 600; // 10 minutes — signin -> callback window
const DEFAULT_SESSION_COOKIE = "auth_token";
const DEFAULT_SESSION_TTL = 86400; // 24h

/**
 * Owns the OAuth web-login wiring for `security.auth.type: oauth`:
 *   GET /auth/signin   -> build authorize URL, stash PKCE state in a signed temp cookie, 302
 *   GET /auth/callback -> exchange code -> principal, mint session JWT, set cookie, redirect
 *   GET /auth/logout   -> clear session cookie, redirect
 * Per-request auth (session JWT verify) is in-process and lives in AuthHandler.
 */
class OAuthHandler {
  constructor(config, defaultTimeout) {
    this.config = config;
    this.auth = config.security?.auth || {};
    this.session = this.auth.session || {};
    this.providers = this.auth.providers || {};
    this.production = !!config.production;
    this.timeout = defaultTimeout || 30000;

    this.sessionSecret = this.session.secret;
    this.sessionCookie = this.session.cookie || DEFAULT_SESSION_COOKIE;
    this.sessionTtl = this.session.ttl || DEFAULT_SESSION_TTL;
    this.redirectAfterLogin = this.auth.redirectAfterLogin || "/";
    this.redirectOnError = this.auth.redirectOnError || this.redirectAfterLogin;
  }

  get enabled() {
    return (this.auth.type || "") === "oauth";
  }

  defaultProvider() {
    const names = Object.keys(this.providers);
    return names.length === 1 ? names[0] : null;
  }

  resolveProvider(name) {
    const providerName = name || this.defaultProvider();
    if (!providerName) return null;
    const provider = this.providers[providerName];
    if (!provider) return null;
    return { name: providerName, ...provider };
  }

  register(app) {
    app.get("/auth/signin", (request, reply) => this.handleSignin(request, reply));
    app.get("/auth/callback", (request, reply) => this.handleCallback(request, reply));
    app.get("/auth/logout", (request, reply) => this.handleLogout(request, reply));
  }

  async handleSignin(request, reply) {
    const provider = this.resolveProvider(request.query?.provider);
    if (!provider) {
      return reply.status(400).send({ message: "Bad Request", error: "Unknown OAuth provider", statusCode: 400 });
    }

    const args = ["oauth", "authorize-url", "--provider", provider.name, "--clientId", provider.clientId, "--redirectUri", provider.redirectUri];
    if (provider.scopes) args.push("--scopes", provider.scopes);
    if (provider.authUrl) args.push("--authUrl", provider.authUrl);

    let result;
    try {
      result = await this.runOAuth(args);
    } catch {
      return this.redirectError(reply);
    }

    if (!result || !result.url || !result.codeVerifier || !result.state) {
      return this.redirectError(reply);
    }

    // Stateless PKCE state carrier: signed, short-lived, httpOnly cookie.
    const stateToken = SessionToken.sign(
      { codeVerifier: result.codeVerifier, state: result.state, provider: provider.name },
      this.sessionSecret,
      TEMP_COOKIE_TTL
    );

    reply.setCookie(TEMP_COOKIE, stateToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: this.production,
      path: "/",
      maxAge: TEMP_COOKIE_TTL
    });

    return reply.redirect(result.url);
  }

  async handleCallback(request, reply) {
    const code = request.query?.code;
    const state = request.query?.state;

    const stateToken = (request.cookies || {})[TEMP_COOKIE];
    CookieHandler.clearCookie(reply, TEMP_COOKIE);

    if (!code || !stateToken) {
      return this.redirectError(reply);
    }

    const stash = SessionToken.verify(stateToken, this.sessionSecret);
    if (!stash || stash.state !== state) {
      return this.redirectError(reply);
    }

    const provider = this.resolveProvider(stash.provider);
    if (!provider) {
      return this.redirectError(reply);
    }

    const args = [
      "oauth", "exchange",
      "--provider", provider.name,
      "--clientId", provider.clientId,
      "--code", code,
      "--codeVerifier", stash.codeVerifier,
      "--redirectUri", provider.redirectUri
    ];
    if (provider.clientSecret) args.push("--clientSecret", provider.clientSecret);
    if (provider.tokenUrl) args.push("--tokenUrl", provider.tokenUrl);
    if (provider.userinfoUrl) args.push("--userinfoUrl", provider.userinfoUrl);
    if (provider.map) args.push("--map", typeof provider.map === "string" ? provider.map : JSON.stringify(provider.map));

    let principal;
    try {
      principal = await this.runOAuth(args);
    } catch {
      return this.redirectError(reply);
    }

    if (!principal || typeof principal !== "object") {
      return this.redirectError(reply);
    }

    // Session claims = principal. Drop any token material the exchange may include.
    const claims = { ...principal };
    delete claims.accessToken;
    delete claims.access_token;
    delete claims.idToken;
    delete claims.id_token;
    delete claims.refreshToken;
    delete claims.refresh_token;

    const sessionJwt = SessionToken.sign(claims, this.sessionSecret, this.sessionTtl);

    reply.setCookie(this.sessionCookie, sessionJwt, {
      httpOnly: true,
      sameSite: "lax",
      secure: this.production,
      path: "/",
      maxAge: this.sessionTtl
    });

    return reply.redirect(this.redirectAfterLogin);
  }

  handleLogout(request, reply) {
    CookieHandler.clearCookie(reply, this.sessionCookie);
    const target = request.query?.redirect || this.redirectOnError;
    return reply.redirect(target);
  }

  redirectError(reply) {
    return reply.redirect(this.redirectOnError);
  }

  runOAuth(args) {
    return new Promise((resolve, reject) => {
      execFile("aux4", args, { timeout: this.timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) {
          return reject(error);
        }
        const output = (stdout || "").trim();
        if (!output) {
          return reject(new Error("empty oauth output"));
        }
        try {
          resolve(JSON.parse(output));
        } catch (e) {
          reject(e);
        }
      });
    });
  }
}

module.exports = OAuthHandler;
