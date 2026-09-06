// Mount-prefix resolution for declared REST routes.
//
// aux4/api serves every route declared in `config.api` under a mount prefix so a
// browser/API path like `/api/hello` reaches the route declared `GET /hello`. That
// prefix used to be the hardcoded literal `/api`; it is now configurable via
// `server.basePath`, defaulting to `/api` so existing deployments are byte-identical.
//
// Rules:
//   - default (unset)      -> "/api"
//   - "" or "/"            -> "" (ROOT MOUNT: declared routes served at bare paths)
//   - leading slash forced -> "v1" becomes "/v1"
//   - trailing slash stripped, "/api/" === "/api"
//
// The normalized value is either "" (root mount) or a "/"-prefixed path with no
// trailing slash. Everything downstream keys off that single shape.

function normalizeBasePath(raw) {
  if (raw === undefined || raw === null) return "/api";
  let bp = String(raw).trim();
  if (bp === "" || bp === "/") return "";
  if (!bp.startsWith("/")) bp = "/" + bp;
  bp = bp.replace(/\/+$/, "");
  return bp;
}

// Read + normalize the mount prefix from an app config object.
function resolveBasePath(config) {
  const raw = config && config.server ? config.server.basePath : undefined;
  return normalizeBasePath(raw);
}

// Strip the mount prefix from a URL path, yielding the internal route path used for
// matching and for the command event. Root mount ("") returns the path unchanged.
// Byte-identical to the previous `replace(/^\/api/, "") || "/"` for the "/api" prefix.
function stripBasePath(urlPath, basePath) {
  const p = urlPath || "/";
  if (!basePath) return p;
  return p.startsWith(basePath) ? p.slice(basePath.length) || "/" : p;
}

// The URL prefix that marks a path as owned by the mounted API, e.g. "/api/". Root
// mount has no distinguishing prefix, so this returns null (every path is API-owned).
function apiPathPrefix(basePath) {
  return basePath ? basePath + "/" : null;
}

module.exports = { normalizeBasePath, resolveBasePath, stripBasePath, apiPathPrefix };
