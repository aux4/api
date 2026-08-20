# aux4/api 2.0.11

## Features

### `api lambda` — serve the full Fastify app behind API Gateway

`api handle` is routing-only: it never boots Fastify, so `@fastify/static`,
convention-based views, and binary downloads are unavailable. The new `api lambda`
command runs the **entire** application — the same app as `api start`, with every
plugin registered — through [`@fastify/aws-lambda`](https://github.com/fastify/aws-lambda-fastify),
so a single warm Lambda container serves REST routes **plus** static files and
file downloads.

```bash
echo '{ "httpMethod": "GET", "path": "/static/logo.png", "headers": {}, "body": null, "isBase64Encoded": false, "requestContext": { "identity": { "sourceIp": "1.2.3.4" } } }' \
  | aux4 api lambda --configFile config.yaml
```

- **URL layout** — REST routes under `/api/`, static assets under `/static/`,
  views at the root — the same split as `api start`.
- **Downloads survive API Gateway** — a `data:<mime>;base64,...` (or otherwise
  binary) response is returned with `isBase64Encoded: true`. Front the function
  with a gateway configured for `binaryMediaTypes = ["*/*"]` so the base64 is
  decoded back to bytes for the client. The base64 decision is made from the
  response `Content-Type` (text-ish → UTF-8, everything else → binary).
- **Warm reuse** — the app is built once per container and reused across
  invocations (no per-request rebuild), unlike `api handle`.

Reads one API Gateway proxy event on stdin and writes the proxy response to
stdout, exactly like `api handle`. Choose `api handle` for a REST-only app with
the smallest cold start; choose `api lambda` when the app also serves static
files or downloads.

**Not supported** (need a live socket — use `api start`): WebSocket routes, SSE
streaming (`stream: true`), and multipart uploads.
