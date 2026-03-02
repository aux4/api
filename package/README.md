# Aux4 API Server

A Fastify-based HTTP server that bridges web requests to aux4 CLI commands using an AWS API Gateway-compatible request/response format. Supports REST APIs, WebSocket connections, convention-based Handlebars views, and static file serving.

## Installation

```bash
aux4 install aux4/api
```

## Quick Start

```bash
aux4 api start
```

With a configuration file:

```bash
aux4 api start --configFile config.yaml --port 3000
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
      command: say
    "POST /users/{id}":
      command: update-user
  ws:
    "/chat":
      routes:
        $connect: chat-connect
        $disconnect: chat-disconnect
        $default: chat-message
        sendMessage: chat-send
  cors:
    origin: "*"
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]
    credentials: false
```

## REST API

Routes are defined in `config.api` with the format `"METHOD /path"`. Path parameters use `{name}` syntax.

When a request matches a route:

1. An AWS API Gateway-style event is built and piped to the aux4 command via stdin
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

```json
{
  "statusCode": 200,
  "headers": { "Content-Type": "text/plain" },
  "body": "hello Joe"
}
```

### Example

**.aux4:**

```json
{
  "name": "say",
  "execute": ["stdin:node say-handler.js"],
  "help": { "text": "Say hello" }
}
```

**say-handler.js:**

```javascript
const event = JSON.parse(require("fs").readFileSync(0, "utf8"));
const name = event.queryStringParameters?.name || "World";
const response = {
  statusCode: 200,
  headers: { "Content-Type": "text/plain" },
  body: `hello ${name}`
};
console.log(JSON.stringify(response));
```

```bash
curl http://localhost:8080/api/say?name=Joe
# hello Joe
```

## WebSocket Support

WebSocket routes are defined in `config.ws`. Each path maps lifecycle events and custom actions to aux4 commands.

### Route Keys

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
