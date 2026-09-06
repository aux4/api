#### Description

Launches a Fastify-based HTTP server that bridges web requests to CLI commands using an AWS API Gateway-compatible request/response format. A `.pid` file is written to the working directory on startup. Use `aux4 api stop` to shut down the server.

The server supports:

- **REST API** endpoints that map HTTP routes to commands (event piped via stdin, response via stdout)
- **Configurable mount prefix** — declared routes are served under `server.basePath` (default `/api`); set it to `/v1` to serve there, or to `/` (or `""`) for ROOT MOUNT, serving declared routes at bare paths
- **Wildcard methods and catch-all paths** — `ANY` (or `*`) matches every HTTP method; `{path...}` greedily captures the rest of the path
- **WebSocket** connections following AWS API Gateway WebSocket patterns
- **Convention-based views** using Handlebars templates from the `views/` directory
- **Static file serving** from the `static/` directory
- **File uploads** with configurable limits
- **Command timeout** with global and per-route configuration
- **SSE streaming** for long-running commands via `stream: true`
- **Form URL-encoded** body parsing
- **HTTPS/TLS** support via key and cert file paths
- **Security** features: API key authentication, rate limiting, security headers (Helmet), and IP allowlist

#### Usage

```bash
aux4 api start [--configFile <file>] [--config <config>] [--port <number>]
```

--configFile  Path to configuration file (YAML or JSON)
--config      Configuration profile name
--port        Server port (default: 8080, env: AUX4_API_PORT)

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

REST API routes are served under the mount prefix `server.basePath` (default `/api`, so `/api/*`). Views from `views/` are served as GET routes. Static files from `static/` are served at `/static/*`. WebSocket management API is available at `POST /@connections/:connectionId` and `DELETE /@connections/:connectionId`.

#### Mount Prefix

Declared routes are served under `server.basePath`. The default is `/api`, so `GET /hello` is reachable at `/api/hello`. A leading slash is added if missing (`v1` → `/v1`) and a trailing slash is stripped (`/api/` === `/api`). The command always receives the app-facing path (`/hello`) — the prefix is a mount concern, not part of the path the command sees.

Set `basePath` to `/` (or `""`) for **root mount**: declared routes are served at bare paths, letting the server stand in for a real host (a programmable mock, a webhook receiver, a site root).

```yaml
config:
  server:
    basePath: /            # root mount — bare paths
  api:
    "ANY /{path...}":
      command: aux4 my-handler respond
```

Under root mount the REST handler registers a bare `/*` catch-all. Fastify gives more-specific registered routes priority over it, so `/static/`, `/media/`, the OAuth `/auth/...` routes, WebSocket, and the views `index.hbs` SPA 404-fallback all keep working; only paths no other handler owns reach the catch-all. CORS preflight (`OPTIONS`) is handled by the CORS layer at root. With a global `security.allowedIPs`, root mount applies it to every path (no prefix to carve out), and a per-route `allowedIPs` cannot loosen it.

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

#### Timeout

Commands time out after 30 seconds by default. Set `server.timeout` for global override or `timeout` on individual routes.

#### SSE Streaming

Set `stream: true` on a route to stream command stdout as Server-Sent Events (`text/event-stream`).

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

Set `security.auth.type: oauth` to enable OAuth2/OIDC web login. The server auto-wires `GET /auth/signin`, `GET /auth/callback`, and `GET /auth/logout`, shells to the `aux4/oauth` package for the authorization-code + PKCE exchange, and issues an HS256 session cookie that it verifies in-process on each request (injecting `${principal.*}` into route commands). See the README for the full `security.auth.type: oauth` configuration and flow.
