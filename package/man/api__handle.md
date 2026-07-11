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
