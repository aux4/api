#### Description

The `handle` command runs a **single API Gateway REST v1 proxy event** through the aux4/api routing engine **in-process** — no HTTP server, no listening socket. It reads one event as JSON on **stdin**, matches it against `config.api` (plus any component routes), executes the mapped command, and writes an API Gateway **proxy response** as JSON to **stdout**:

```json
{
  "statusCode": 200,
  "headers": {
    "content-type": "application/json"
  },
  "body": "...",
  "isBase64Encoded": false
}
```

This is the one-event-per-invocation entrypoint the AWS Lambda runtime calls when running a multi-route aux4/api app as a container image behind API Gateway. It reuses the exact same routing, authentication, rate-limiting, cookie, redirect, and response-shaping logic as `aux4 api start` — the request/response are adapted to the event/response contract instead of a live Fastify socket.

- **Event shape** — expects an **API Gateway REST API (v1) / payload format 1.0** proxy event: `httpMethod`, `path`, `headers` (flat), `queryStringParameters` / `multiValueQueryStringParameters`, `body`, `isBase64Encoded`, and `requestContext.identity.sourceIp`. `pathParameters` in the event are ignored and recomputed by matching `path` against the route patterns.
- **Routing** — `path` is matched against `config.api` route patterns (`"METHOD /path"`, with `{name}` segments captured as path parameters), identical to the running server.
- **Request context** — the matched command receives the same `--params` / `--query` / `--headers` / `--cookies` / `--principal` / `--body` flags and the full event on stdin as it does under `api start`.
- **Response contract** — a command that prints JSON with a `statusCode` produces that gateway response verbatim (headers/body/base64 honored); a command that prints plain JSON is wrapped as `200 application/json`; binary/`data:` output is base64-encoded with `isBase64Encoded: true`. `Set-Cookie` from `setCookie`/`clearCookie` routes is emitted (multiple cookies via `multiValueHeaders`).
- **Base64 request bodies** — if the event has `isBase64Encoded: true`, the body is decoded before routing.
- **Components** — if `config.components` is present, component routes are merged under their mount paths exactly as the running server does.

##### CORS

`api handle` honors `config.cors` with the same semantics as `api start`, computed in-process without Fastify (`api start` uses `@fastify/cors`; this path never runs Fastify, so it computes the equivalent headers itself). When `config.cors` is absent or empty, no `Access-Control-*` headers are emitted and behavior is unchanged.

- **OPTIONS preflight** — an `OPTIONS` request is answered directly with `204 No Content` and the preflight header set (`Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`, and `Access-Control-Max-Age` when configured); the mapped command never runs. If the origin is not allowed (or `config.cors` is absent), the `OPTIONS` request falls through to normal routing instead.
- **Actual responses** — every non-preflight response (command success, `404`, `415`, `501`, and the non-zero-exit `500`) gets `Access-Control-Allow-Origin` (plus `Access-Control-Allow-Credentials` and `Access-Control-Expose-Headers` when configured) merged in. The preflight-only headers (`Allow-Methods`, `Allow-Headers`, `Max-Age`) are never added to actual responses.

`config.cors` reference:

| Field | Type | Behavior |
|-------|------|----------|
| `origin` | string | `"*"` allows any origin and emits `Access-Control-Allow-Origin: *` with no `Vary`. Any other string is a single allowed origin — the request `Origin` is echoed (with `Vary: Origin`) only when it matches. |
| `origin` | array | Allowlist — the request `Origin` is echoed (with `Vary: Origin`) only when it is a member. Every member is matched independently, so multiple URLs (e.g. a production domain plus local dev servers) are all allowed. |
| `origin` | `true` | Reflect — echoes the request `Origin` back with `Vary: Origin`. |
| `origin` | `false` | CORS disabled — no headers emitted. |
| `methods` | string/array | `Access-Control-Allow-Methods` on the preflight (default `GET,POST,PUT,DELETE,PATCH,OPTIONS`). |
| `allowedHeaders` | string/array | `Access-Control-Allow-Headers` on the preflight. When unset, the browser's `access-control-request-headers` is reflected (falling back to `Content-Type,Authorization`). |
| `exposedHeaders` | string/array | `Access-Control-Expose-Headers` on the actual response. |
| `credentials` | boolean | When `true`, adds `Access-Control-Allow-Credentials: true`. |
| `maxAge` | number | `Access-Control-Max-Age` (seconds) on the preflight only. |

**Credentials + wildcard rule:** the Fetch spec forbids `Access-Control-Allow-Credentials: true` together with `Access-Control-Allow-Origin: *`. When `credentials: true` and `origin` resolves to `*`, the handler reflects the request `Origin` (with `Vary: Origin`) instead of emitting `*`, so credentialed cross-origin requests succeed.

Configuration file:

```yaml
config:
  cors:
    origin:
      - https://aux4.io
      - http://localhost:5173
    credentials: true
    exposedHeaders:
      - X-Total-Count
    maxAge: 600
  api:
    "GET /contacts":
      command: aux4 contacts list
```

##### Limitations

The event path has no live socket, so the following route kinds are **not supported** through `api handle` and are rejected explicitly:

- **Streaming (SSE) routes** (`stream: true`) → `501 Not Implemented`.
- **Multipart uploads** (`multipart/form-data`) → `415 Unsupported Media Type`.
- **WebSocket routes** — not part of the REST proxy event path at all.

Use `aux4 api start` for those transports.

#### Usage

```bash
aux4 api handle --configFile <config.yaml> < event.json
```

--configFile   Path to the config file whose `config.api` defines the routes (populates `cors`, `api`, `ws`, `server`, `tls`, `security`, `production`, `components`)

The event is read from stdin; the proxy response is written to stdout.

#### Example

Configuration file:

```yaml
config:
  api:
    "GET /contacts/{id}":
      command: aux4 contacts get
```

```bash
echo '{
  "httpMethod": "GET",
  "path": "/contacts/123",
  "headers": { "accept": "application/json" },
  "body": null,
  "isBase64Encoded": false,
  "requestContext": { "requestId": "r1", "identity": { "sourceIp": "1.2.3.4" } }
}' | aux4 api handle --configFile config.yaml
```

```json
{
  "statusCode": 200,
  "headers": {
    "content-type": "application/json"
  },
  "body": "{\"id\":\"123\"}",
  "isBase64Encoded": false
}
```
