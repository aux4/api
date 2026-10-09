#### Description

Launches a Fastify-based HTTP server that bridges web requests to CLI commands using an AWS API Gateway-compatible request/response format. A `.pid` file is written to the working directory on startup. Use `aux4 api stop` to shut down the server.

The server supports:

- **REST API** endpoints that map HTTP routes to commands (event piped via stdin, response via stdout)
- **Wildcard methods and catch-all paths** — `ANY` (or `*`) matches every HTTP method; `{path...}` greedily captures the rest of the path
- **WebSocket** connections following AWS API Gateway event shapes. In this
  persistent-server mode, `@fastify/websocket` owns the HTTP Upgrade and socket;
  API Gateway WebSocket Lambda events use `aux4 api lambda` instead.
- **Convention-based views** using Handlebars templates from the `views/` directory
- **Static file serving** from the `static/` directory
- **File uploads** with configurable limits
- **Command timeout** with global and per-route configuration
- **SSE streaming** for long-running commands via `stream: true`
- **Session streaming** (`config.sessions`) — a long-lived command with a
  create/input/end REST lifecycle and an SSE output stream, or the WebSocket
  equivalent via `stream: true` on a `config.ws` route
- **Form URL-encoded** body parsing
- **HTTPS/TLS** support via key and cert file paths
- **Security** features: API key authentication, rate limiting, security headers (Helmet), and IP allowlist
- **Trusted in-process package handlers** for latency-sensitive REST routes and
  bearer/cookie validators, sharing the command concurrency and timeout limits

#### Usage

```bash
aux4 api start [--configFile <file>] [--config <config>] [--port <number>]
```

--configFile  Path to configuration file (YAML or JSON)
--config      Configuration profile name
--port        Server port (default: 8080, env: AUX4_API_PORT)
--sessions    Session streaming route configuration (normally set via config.yaml, not this flag directly)

#### Example

```bash
aux4 api start --configFile config.yaml
```

```text
aux4 api started on port 8080
```

Configuration file:

```yaml
config:
  port: 8080
  api:
    "GET /say":
      command: aux4 say
      handler:
        package: myscope/say
        module: lib/api-handler.mjs
        factory: createApiHandler
        method: handle
        identity: say-api-v1
    "POST /users/{id}":
      command: aux4 update-user
  ws:
    "/chat":
      routes:
        $connect: aux4 chat-connect
        $disconnect: aux4 chat-disconnect
        $default: aux4 chat-message
        sendMessage: aux4 chat-send
  server:
    limits:
      files: 5
      fileSize: 10485760
      fieldSize: 1048576
      parts: 10
  cors:
    origin: "*"
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]
    credentials: false
```

The `command` field specifies the full shell command to execute. The API Gateway event is piped via stdin. The command output is handled based on its format:

- **JSON with `statusCode`** — API Gateway response (status, headers, body)
- **JSON without `statusCode`** — 200 with JSON body
- **Plain text** — 200 with text body
- **`data:<mimetype>;base64,<data>`** — binary response with auto Content-Type and optional `filename` parameter
- **Command fails** — 500 with stdout/stderr as body

REST API routes are served at `/api/*`. Views from `views/` are served as GET routes. Static files from `static/` are served at `/static/*`. WebSocket management API is available at `POST /@connections/:connectionId` and `DELETE /@connections/:connectionId`.

#### Route Matching

Route keys use the format `"METHOD /path"`:

- **Exact** — `GET /users` matches only that method and path.
- **Single-segment param** — `GET /users/{id}` captures one path segment (no `/`) as `${params.id}`.
- **Wildcard method** — `ANY /users/{id}` (or `* /users/{id}`) matches every HTTP method for that path.
- **Greedy catch-all path** — `GET /files/{path...}` captures the remaining path *including* slashes as `${params.path}`.
- **Full catch-all** — `ANY /{path...}` matches every method on every path; the command reads the method from the event's `httpMethod` and the path from `${params.path}` (`.pathParameters.path`).

Specific routes always win over catch-alls regardless of declaration order: an exact method beats `ANY`, and a single-segment `{name}` beats a greedy `{path...}`. Equally-specific routes keep their declaration order. So `GET /health` declared next to `ANY /{path...}` still reaches its own command, while all other requests fall through to the catch-all.

```yaml
config:
  api:
    "GET /health":
      command: aux4 health-check
    "ANY /{path...}":
      command: aux4 my-handler respond
      public: true
```

#### Command Concurrency

Limits concurrent child processes to prevent resource exhaustion. Configurable via `server.maxConcurrency` (default: 50) and `server.maxQueue` (default: 200). Returns 503 when the queue is full.

Trusted in-process handlers use the same limits. Configure `handler.package` as
an installed `scope/name`, `handler.module` as a package-relative module,
`handler.factory` as the exported factory (`createHandler` by default), and
`handler.method` as the returned runtime method (`handle` by default). The
factory is cached for the warm server's package/configuration identity. The
handler must return `{ exitCode, stdout, stderr }`; stdout follows the same
response rules as a command. Absolute, cross-package, symlink-escaped, or
request-selected modules are rejected. Changing trusted configuration retires
the old runtime after active calls finish.

#### Large Request Bodies

`${body.field}`/`value(body)` and the other command-variable flags (`params`, `query`, `headers`,
`cookies`, `principal`) reach the command as `--body`/`--params`/etc. shell arguments. Any single one
of them whose serialized value exceeds 64 KiB is **not** passed as an argument — it is silently
omitted, so `${body.field}`/`value(body)` resolve empty for an oversized body. This keeps the
command's spawn well under the Linux single-argument limit a large payload would otherwise overflow,
which previously surfaced as an opaque `500 Internal Server Error`.

The complete, untruncated body is always still piped to the command on **stdin** as part of the
AWS API Gateway-style event, regardless of size. A route expecting large bodies (uploads, audio/video
payloads, etc.) should have its command read the body from stdin instead of relying on
`${body.field}`/`value(body)`/`--body`.

#### Timeout

Commands time out after 30 seconds by default. Set `server.timeout` for global override or `timeout` on individual routes.

In-process handlers receive an abort signal on timeout. Their concurrency slot
remains occupied until the operation actually settles, preventing a handler that
ignores cancellation from exceeding the configured limit.

#### SSE Streaming

Set `stream: true` on a route to stream command stdout as Server-Sent Events (`text/event-stream`). This is one-shot: the command runs once per request with no channel for the client to send it input while it runs.

#### Session Streaming

`config.sessions` wires up a generic create/input/end/events lifecycle for a long-lived command, so a client can both feed it input over time and read its output as a stream — not possible with plain `stream: true`:

```yaml
config:
  sessions:
    "/transcribe":
      command: aux4 whisper stream
      idleTimeout: 60000
      maxDuration: 1800000
      maxPerPrincipal: 5
      heartbeat: 15000
      public: false
```

- `POST /api/transcribe` spawns `command` (through the same `security.auth` check as a `config.api` route) and returns `{"id": "..."}`. The session is bound to the caller's principal.
- `POST /api/transcribe/:id/input` writes the raw request body to the command's stdin, byte-for-byte.
- `POST /api/transcribe/:id/end` closes stdin (EOF).
- `GET /api/transcribe/:id/events` streams stdout as SSE (`data: <line>`), with a `: heartbeat` comment every `heartbeat` ms and an `event: end` (preceded by `event: error` on a non-zero exit) when the command exits.

A request to `/input`, `/end`, or `/events` for a session id owned by a different principal returns `404`, identical to a nonexistent session. `maxPerPrincipal` (default 5) caps concurrent sessions per principal across every `config.sessions` route and every WebSocket stream route together — exceeding it returns `429`. `idleTimeout` (default 60000ms) kills the command after that long with no stdin/stdout activity; `maxDuration` (default 1800000ms) kills it unconditionally once the session has run that long. Disconnecting `/events` also tears the command down immediately. Teardown always sends `SIGTERM` first, escalating to `SIGKILL` after 2 seconds if the process is still alive.

The same `stream: true` + `command` shape works on a `config.ws` route instead of the lifecycle `routes` map: the whole WebSocket connection becomes one session, with every client frame written to stdin and every stdout line sent back as a text frame.

#### Form URL-Encoded

`application/x-www-form-urlencoded` POST bodies are automatically parsed into JSON.

#### HTTPS/TLS

Provide `tls.key` and `tls.cert` file paths to enable HTTPS:

```yaml
config:
  tls:
    key: path/to/key.pem
    cert: path/to/cert.pem
```

#### Security

Authentication (API key, cookie, bearer, or full OAuth2/OIDC web login), rate limiting, security headers, and IP allowlist. All features are optional.

```yaml
config:
  security:
    apiKey: my-secret-key
    header: X-API-Key
    rateLimit:
      max: 100
      timeWindow: 60000
    helmet: true
    allowedIPs:
      - 127.0.0.1
      - 192.168.1.0/24
```

Routes can be marked `public: true` to skip API key checks. Per-route `allowedIPs` replaces the global list. Per-route `rateLimit` is additive to global. Behind a reverse proxy, set `server.trustProxy: true` so `request.ip` reflects the real client IP.

Set `security.auth.type: oauth` to enable OAuth2/OIDC web login. The server auto-wires `GET /auth/signin`, `GET /auth/callback`, and `GET /auth/logout`, shells to the `aux4/oauth` package for the authorization-code + PKCE exchange, and issues a sealed session cookie that it opens in-process on each request (injecting `${principal.*}` into route commands and the user's access token as `AUX4_ACCESS_TOKEN`). A session that cannot supply a delegated token — a legacy identity-only cookie with no embedded OAuth credentials — is forced to re-authenticate with `401 Authentication required` instead of silently running a route command without `AUX4_ACCESS_TOKEN`; set `security.auth.session.requireDelegation: false` to opt out for routes that need no delegated token. See the README for the full `security.auth.type: oauth` configuration and flow.

When `security.auth` is configured (any type), it gates the whole HTML surface, not just `/api/*`: convention-based view routes and the 404 SPA-shell fallback run through the same auth check, and an unauthenticated `GET` gets a real `302` to the login page instead of a bare `401`. `/auth/*`, `/static/*`, `/media/*`, and `/aux4/*` always stay reachable; add more exceptions with `security.auth.publicPaths` (a list of path prefixes). With no `security.auth` configured, every page stays public. See the README's "Page-Level Auth" section.
