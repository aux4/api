// Dependency-free CORS header computation for the handler/Lambda path ('api handle').
//
// 'api start' (lib/Server.js) applies CORS via @fastify/cors. The Lambda/serverless path
// (lib/handleCommand.js -> RestHandler.dispatch) never runs Fastify, so it must compute the
// same headers itself. This helper mirrors @fastify/cors config semantics (origin / methods /
// allowedHeaders / exposedHeaders / credentials / maxAge) WITHOUT pulling @fastify/cors into
// the Lambda bundle.
//
// Contract: returns null when there is nothing to emit — either because no CORS config is
// present (config.cors absent/empty, so apps without cors keep serving no Access-Control-*
// headers) or because the request Origin is not in the configured allowlist (so a disallowed
// origin never gets Access-Control-Allow-Origin echoed back). Otherwise returns a plain object
// of header-name -> value.

const DEFAULT_METHODS = "GET,POST,PUT,DELETE,PATCH,OPTIONS";
const DEFAULT_ALLOWED_HEADERS = "Content-Type,Authorization";

function isEmptyCorsConfig(cors) {
  if (cors === undefined || cors === null || cors === "") return true;
  if (typeof cors === "object" && !Array.isArray(cors) && Object.keys(cors).length === 0) return true;
  return false;
}

// Resolve Access-Control-Allow-Origin against config.cors.origin, mirroring @fastify/cors.
// Returns { value, vary } or null when no origin header should be emitted.
function resolveAllowOrigin(originConfig, requestOrigin) {
  // cors config present but origin unset -> @fastify/cors defaults origin to "*".
  if (originConfig === undefined || originConfig === null) {
    return { value: "*", vary: false };
  }

  // Wildcard: allow any origin, no per-origin echo (so no Vary needed).
  if (originConfig === "*") {
    return { value: "*", vary: false };
  }

  // true -> reflect the request Origin (falls back to "*" when no Origin header is present).
  if (originConfig === true) {
    return requestOrigin ? { value: requestOrigin, vary: true } : { value: "*", vary: false };
  }

  // false -> CORS disabled: emit nothing.
  if (originConfig === false) {
    return null;
  }

  // Single allowed origin: echo the request Origin only when it matches.
  if (typeof originConfig === "string") {
    if (requestOrigin && requestOrigin === originConfig) return { value: requestOrigin, vary: true };
    return null;
  }

  // Allowlist: echo the request Origin only when it is a member of the list.
  if (Array.isArray(originConfig)) {
    if (requestOrigin && originConfig.includes(requestOrigin)) return { value: requestOrigin, vary: true };
    return null;
  }

  return null;
}

function joinList(value) {
  return Array.isArray(value) ? value.join(",") : value;
}

// Compute the CORS response headers for a request. `preflight` selects the full preflight set
// (methods / allowed-headers / max-age) vs the smaller set that belongs on an actual response,
// matching @fastify/cors, which only reflects Allow-Origin/credentials/expose on actual
// responses and adds Allow-Methods/Allow-Headers/Max-Age on the OPTIONS preflight.
function computeCorsHeaders(cors, request, preflight) {
  if (isEmptyCorsConfig(cors)) return null;

  // A bare string cors value is treated as the allowed origin.
  const config = typeof cors === "string" ? { origin: cors } : cors;

  const requestHeaders = (request && request.headers) || {};
  const requestOrigin = requestHeaders.origin || requestHeaders.Origin;

  const allow = resolveAllowOrigin(config.origin, requestOrigin);
  if (!allow) return null;

  const headers = {};

  // Fetch spec rule: Access-Control-Allow-Credentials: true must never be paired with a
  // wildcard Access-Control-Allow-Origin ("*"). A browser rejects that combination, so a
  // credentialed request would fail. When credentials are enabled and the origin resolves
  // to "*" (config.origin is "*", true-with-no-match fallback, or unset), reflect the request
  // Origin instead (with Vary: Origin) so the response is actually usable. Without a request
  // Origin there is no credentialed cross-origin request to satisfy, so "*" is left untouched.
  if (config.credentials && allow.value === "*" && requestOrigin) {
    allow.value = requestOrigin;
    allow.vary = true;
  }

  headers["Access-Control-Allow-Origin"] = allow.value;
  if (allow.vary) headers["Vary"] = "Origin";

  if (config.credentials) headers["Access-Control-Allow-Credentials"] = "true";

  const exposedHeaders = joinList(config.exposedHeaders);
  if (exposedHeaders) headers["Access-Control-Expose-Headers"] = exposedHeaders;

  if (preflight) {
    headers["Access-Control-Allow-Methods"] = joinList(config.methods) || DEFAULT_METHODS;

    const allowedHeaders =
      joinList(config.allowedHeaders) ||
      requestHeaders["access-control-request-headers"] ||
      DEFAULT_ALLOWED_HEADERS;
    headers["Access-Control-Allow-Headers"] = allowedHeaders;

    if (config.maxAge != null) headers["Access-Control-Max-Age"] = String(config.maxAge);
  }

  return headers;
}

module.exports = { computeCorsHeaders };
