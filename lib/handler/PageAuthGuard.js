const AuthHandler = require("./AuthHandler");

// Prefixes that are always reachable without a session, regardless of `security.auth` —
// they are infrastructure routes, not application pages: the OAuth login dance itself
// (/auth/*, registered by OAuthHandler), static assets, the media directory, and the
// aux4-component.js loader/batch endpoints. REST routes (/api/*) are excluded too — those
// are gated independently by RestHandler/AuthHandler with their own per-route `public`
// flag and JSON error shape; this guard only ever sees HTML page requests.
const ALWAYS_PUBLIC_PREFIXES = ["/api/", "/auth/", "/static/", "/media/", "/aux4/"];

/**
 * Builds the preHandler that gates aux4/api's HTML surface — the convention-based
 * views (ViewHandler) and the 404 SPA-shell fallback — behind `security.auth`.
 *
 * Without this, `security.auth` only protected JSON `/api/*` routes: any `GET /` or
 * `GET /apps/{id}` style page route, and the unmatched-route SPA shell, were served to
 * anyone with no auth check at all. See aux4/api PKG-API-014.
 *
 * Behavior:
 *  - No `security.auth` configured (or disabled via `disableWhenEnv`) -> no-op, every
 *    page stays public exactly as before this fix.
 *  - `security.auth` configured -> every page route not covered by
 *    ALWAYS_PUBLIC_PREFIXES or `security.auth.publicPaths` runs the same
 *    `AuthHandler.authenticate` used for `/api/*`. On success, `request.principal` is
 *    set (mirroring RestHandler) for any view/component that wants it.
 *  - On failure: a GET request (what a browser navigation is) with a configured login
 *    redirect (`security.auth.type: oauth` defaults to `/auth/signin`; otherwise
 *    `security.auth.redirect` / `redirectOnError`) gets a real `302` there — so the
 *    browser actually lands on the sign-in page instead of a bare JSON 401 body. A 403
 *    (authenticated but missing `requiredScope`) is never redirected, to avoid a login
 *    loop. With no redirect configured, falls back to the same JSON error RestHandler
 *    returns for `/api/*`.
 */
function createPageAuthGuard(config, commandPool, defaultTimeout) {
  const auth = config.security?.auth;
  const authHandler = new AuthHandler(config, commandPool, defaultTimeout);

  const configuredPublicPaths = Array.isArray(auth?.publicPaths) ? auth.publicPaths : [];
  const publicPrefixes = [...ALWAYS_PUBLIC_PREFIXES, ...configuredPublicPaths];

  const loginRedirect = (auth && (auth.type === "oauth" ? auth.redirectOnError || "/auth/signin" : auth.redirect || auth.redirectOnError)) || null;

  return async function pageAuthGuard(request, reply) {
    if (!authHandler.enabled) return;

    const url = request.url.replace(/\?.*$/, "");
    if (publicPrefixes.some(prefix => url === prefix.replace(/\/$/, "") || url.startsWith(prefix))) return;

    // An API Gateway custom authorizer already validated the caller at the edge.
    if (request.authorizer && (request.authorizer.sub || request.authorizer.principalId)) return;

    const result = await authHandler.authenticate(request);
    if (result.error) {
      const status = result.status || 401;
      if (status === 401 && request.method === "GET" && loginRedirect) {
        return reply.redirect(loginRedirect);
      }
      return reply.status(status).send({
        message: status === 403 ? "Forbidden" : "Unauthorized",
        error: result.error,
        statusCode: status
      });
    }

    request.principal = result.principal;
  };
}

module.exports = { createPageAuthGuard };
