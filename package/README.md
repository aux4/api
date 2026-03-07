# Aux4 API Server

A Fastify-based HTTP server that bridges web requests to CLI commands using an AWS API Gateway-compatible request/response format. Supports REST APIs, WebSocket connections, convention-based Handlebars views, and static file serving.

## Installation

```bash
aux4 aux4 pkger install aux4/api
```

## Quick Start

```bash
aux4 api start
```

With a configuration file:

```bash
aux4 api start --configFile config.yaml
```

Stop the server:

```bash
aux4 api stop
```

## Configuration

```yaml
config:
  port: 8080
  server:
    limits:
      files: 5
      fileSize: 10485760
      fieldSize: 1048576
      parts: 10
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
  cors:
    origin: "*"
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]
    credentials: false
```

## REST API

Routes are defined in `config.api` with the format `"METHOD /path"`. Path parameters use `{name}` syntax. The `command` field specifies the full shell command to execute.

When a request matches a route:

1. An AWS API Gateway-style event is built and piped to the command via stdin
2. The command returns an API Gateway-compatible response on stdout

### Event Format (stdin)

```json
{
  "httpMethod": "GET",
  "path": "/say",
  "headers": { ... },
  "queryStringParameters": { "name": "Joe" },
  "multiValueQueryStringParameters": { "name": ["Joe"] },
  "pathParameters": null,
  "body": null,
  "isBase64Encoded": false,
  "requestContext": {
    "httpMethod": "GET",
    "path": "/api/say",
    "requestId": "uuid",
    "identity": { "sourceIp": "127.0.0.1" }
  }
}
```

### Response Format (stdout)

The command output is handled based on its format:

| Output | Behavior |
|--------|----------|
| JSON with `statusCode` | API Gateway response (status, headers, body) |
| JSON without `statusCode` | 200 with JSON body |
| Plain text | 200 with text body |
| `data:<mimetype>;base64,<data>` | Binary response with auto Content-Type |
| Command fails (non-zero exit) | 500 with stdout/stderr as body |

#### API Gateway response

```json
{
  "statusCode": 200,
  "headers": { "Content-Type": "text/plain" },
  "body": "hello Joe"
}
```

#### Plain text

```
hello Joe
```

#### Data URI (binary files)

```
data:image/png;filename=photo.png;base64,iVBORw0KGgo...
```

The `filename` parameter is optional. Sets `Content-Type` and `Content-Disposition` automatically.

### Examples

**Plain text response:**

```json
{
  "name": "say",
  "execute": [
    "stdin:jq -rc '\"hello \" + (.queryStringParameters.name // \"World\")'"
  ],
  "help": {
    "text": "Say hello"
  }
}
```

```bash
curl http://localhost:8080/api/say?name=Joe
# hello Joe
```

**Binary file response:**

```json
{
  "name": "image",
  "execute": [
    "nout:base64 -i photo.png",
    "log:data:image/png;filename=photo.png;base64,${response}"
  ],
  "help": {
    "text": "Return an image"
  }
}
```

```bash
curl http://localhost:8080/api/image -o photo.png
```

## WebSocket Support

WebSocket routes are defined in `config.ws`. Each path maps lifecycle events and custom actions to commands.

### Route Keys

All route keys are optional:

- `$connect` — fired when a client connects
- `$disconnect` — fired when a client disconnects
- `$default` — fired when no matching action is found
- `<action>` — custom action matched from `{ "action": "<action>" }` in the message body

### Management API

- `POST /@connections/:connectionId` — send a message to a specific connection
- `DELETE /@connections/:connectionId` — disconnect a specific connection

## Convention-Based Views

Handlebars templates in the `views/` directory are automatically registered as GET routes:

| File | Route | Parameters |
|------|-------|------------|
| `views/index.hbs` | `GET /` | none |
| `views/about.hbs` | `GET /about` | none |
| `views/users/{id}.hbs` | `GET /users/:id` | `{ id }` |
| `views/greet.p.hbs` | `GET /greet` | none (no layout) |

- `.hbs` files render with the layout (`views/layouts/main.hbs`)
- `.p.hbs` files render as partials (no layout)
- `views/error.p.hbs` is used for error responses (not registered as a route)
- `{id}` segments in filenames/directories become dynamic path parameters
- `layouts/`, `partials/`, and `i18n/` directories are skipped

## Static File Serving

Files in the `static/` directory are served at the `/static/` URL prefix.

```
static/css/app.css → http://localhost:8080/static/css/app.css
```

## Error Handling

### Error Template

Create `views/error.p.hbs` to customize error pages:

```html
<div>Error {{statusCode}}: {{message}}</div>
```

Error templates receive `statusCode`, `message`, and `error` variables.

### API Errors

API routes (`/api/*`) with `Accept: application/json` return structured JSON errors:

```json
{
  "error": {
    "message": "Route not found",
    "status": 404
  }
}
```

## Environment Variables

- `AUX4_API_PORT` — override the port (takes precedence over config file)
