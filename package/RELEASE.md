# aux4/api 2.0.8

## Fixes

### `api handle` no longer returns 500 for a valid response that exits non-zero

The PROXY / Lambda handler (`api handle`) previously returned a blanket HTTP 500
whenever the route command exited non-zero, discarding the command's output. A
command can emit a complete, valid response on stdout and still exit non-zero
(shell / exit-code aggregation, or a trailing non-fatal error in a downstream
tool). The handler now delivers that response when stdout carries a well-formed
JSON body, and logs the command's stderr + exit code so the condition is
diagnosable instead of an opaque 500. It still returns 500 when there is no
usable response.

### CORS is now honored on the `api handle` (serverless / Lambda) path

`config.cors` was a silent no-op on the `api handle` path, which never runs
Fastify. It now applies the same CORS semantics as `api start` — `origin`
(string / array / `true` / `false` / `"*"`), `methods`, `allowedHeaders`,
`exposedHeaders`, `credentials`, `maxAge` — computed without Fastify. OPTIONS
preflight is answered with `204` and the full preflight header set; actual
responses carry the appropriate `Access-Control-*` headers on every path.

- **Multiple allowed origins** are supported: each member of an `origin`
  allowlist is echoed back independently (with `Vary: Origin`).
- `Access-Control-Allow-Credentials: true` is never emitted together with
  `Access-Control-Allow-Origin: *` — the request origin is reflected instead,
  fixing a spec violation that browsers reject on credentialed requests.
