# Release notes

## Added

- **`server.basePath`** — a configurable mount prefix for declared REST routes,
  defaulting to `/api` so existing servers are unchanged. Set it to a custom prefix
  (e.g. `/v1`) to serve declared routes there, or to `/` (or `""`) for **root mount**,
  which serves declared routes at bare paths. Root mount lets an aux4/api server stand
  in for a real host — a programmable mock, a webhook receiver, a site root — so a
  request like `GET /anything` reaches the mounted command directly instead of only
  under `/api/`.

  Under root mount the REST handler registers a bare `/*` catch-all, and Fastify's
  router gives more-specific registered routes priority over it: static files
  (`/static/`), the uploads directory (`/media/`), the OAuth web-login routes
  (`/auth/...`), WebSocket routes, and the views `index.hbs` SPA 404-fallback all
  continue to work — only paths no other handler owns reach the catch-all. CORS
  preflight (`OPTIONS`) is handled by the CORS layer at root.

## Notes

- With no `basePath` configured, behavior is byte-identical to before: declared routes
  serve under `/api`.
- Under root mount a global `security.allowedIPs` applies to every path (there is no
  prefix to carve out for per-route overrides), so a per-route `allowedIPs` cannot
  loosen the global list in that mode.
