#### Description

Launches a Fastify-based HTTP server that bridges web requests to CLI commands using an AWS API Gateway-compatible request/response format. A `.pid` file is written to the working directory on startup. Use `aux4 api stop` to shut down the server.

The server supports:

- **REST API** endpoints that map HTTP routes to commands (event piped via stdin, response via stdout)
- **WebSocket** connections following AWS API Gateway WebSocket patterns
- **Convention-based views** using Handlebars templates from the `views/` directory
- **Static file serving** from the `static/` directory
- **File uploads** with configurable limits
- **Command timeout** with global and per-route configuration
- **SSE streaming** for long-running commands via `stream: true`
- **Form URL-encoded** body parsing
- **HTTPS/TLS** support via key and cert file paths

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

REST API routes are served at `/api/*`. Views from `views/` are served as GET routes. Static files from `static/` are served at `/static/*`. WebSocket management API is available at `POST /@connections/:connectionId` and `DELETE /@connections/:connectionId`.

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
