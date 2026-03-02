Start the Aux4 API server with optional configuration.

### Synopsis

```bash
aux4 api start [--configFile <file>] [--config <config>] [--port <number>] [options...]
```

### Description

The `aux4 api start` command launches a Fastify-based HTTP server that bridges web requests to aux4 CLI commands using an AWS API Gateway-compatible request/response format.

The server supports:

- **REST API** endpoints that map HTTP routes to aux4 commands (event piped via stdin, response via stdout)
- **WebSocket** connections following AWS API Gateway WebSocket patterns
- **Convention-based views** using Handlebars templates from the `views/` directory
- **Static file serving** from the `static/` directory
- **File uploads** with configurable limits

#### `--port <number>`

Override the server port. Defaults to 8080 if not specified in configuration.

**Example:**

```bash
aux4 api start --port 3000
```

### Configuration File

The configuration file uses YAML format and supports the following structure:

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

### REST API

Routes are defined in `config.api` with the format `"METHOD /path"`. Path parameters use `{name}` syntax.

When a request matches a route:
1. An AWS API Gateway-style event is built with `httpMethod`, `path`, `headers`, `queryStringParameters`, `multiValueQueryStringParameters`, `pathParameters`, `body`, and `requestContext`
2. The event JSON is piped to the aux4 command via stdin
3. The command must return an API Gateway response on stdout:

```json
{
  "statusCode": 200,
  "headers": { "Content-Type": "application/json" },
  "body": "{\"message\": \"hello\"}",
  "isBase64Encoded": false
}
```

**Example command (.aux4):**

```json
{
  "name": "say",
  "execute": ["stdin:node say-handler.js"],
  "help": { "text": "Say hello" }
}
```

**Example handler (say-handler.js):**

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

### WebSocket Support

WebSocket routes are defined in `config.ws`. Each WebSocket path maps lifecycle events and actions to aux4 commands.

#### Route Keys

- `$connect` - Fired when a client connects
- `$disconnect` - Fired when a client disconnects
- `$default` - Fired when no matching action is found
- `<action>` - Custom action matched from `{ "action": "<action>" }` in message body

#### Management API

- `POST /@connections/:connectionId` - Send a message to a specific connection
- `DELETE /@connections/:connectionId` - Disconnect a specific connection

### Convention-Based Views

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

### Configuration Options

#### `config.port`

- **Type:** Number
- **Default:** 8080
- **Description:** Port number for the HTTP server

#### `config.server.limits`

File upload and request limits configuration.

##### `config.server.limits.files`

- **Type:** Number
- **Default:** 5
- **Description:** Maximum number of files allowed in multipart uploads

##### `config.server.limits.fileSize`

- **Type:** Number (bytes)
- **Default:** 10485760 (10MB)
- **Description:** Maximum size per uploaded file

##### `config.server.limits.fieldSize`

- **Type:** Number (bytes)
- **Default:** 1048576 (1MB)
- **Description:** Maximum size for form field values

##### `config.server.limits.parts`

- **Type:** Number
- **Default:** 10
- **Description:** Maximum number of multipart parts allowed

#### `config.cors`

Cross-Origin Resource Sharing (CORS) configuration. Passed directly to `@fastify/cors`.

### Environment Variables

- **`AUX4_API_PORT`**: Override the port (takes precedence over config file)

### Static File Serving

Files in `static/` directory served at `/static/` URL prefix.
Example: `static/css/app.css` → `http://localhost:8080/static/css/app.css`

### Exit Codes

- **0**: Server started successfully
- **1**: General error (configuration, port binding, etc.)
