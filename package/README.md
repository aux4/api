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
    timeout: 30000
    maxConcurrency: 50
    maxQueue: 200
    trustProxy: true
    media: ./media
    limits:
      bodySize: 1048576
      files: 5
      fileSize: 10485760
      fieldSize: 1048576
      parts: 10
  security:
    auth:
      type: cookie
      command: aux4 auth validate
      cookie: auth_token
      redirect: /auth/signin
    rateLimit:
      max: 100
      timeWindow: 60000
    helmet: true
    allowedIPs:
      - 127.0.0.1
  cors:
    origin: "*"
  tls:
    key: path/to/key.pem
    cert: path/to/cert.pem
  production: false
  api:
    "GET /contacts":
      command: aux4 contacts list
    "POST /contacts":
      command: aux4 contacts create
      redirect: /contacts
    "DELETE /contacts/{id}":
      command: aux4 contacts delete
      redirect: /contacts
  ws:
    "/chat":
      routes:
        $connect: aux4 chat-connect
        $disconnect: aux4 chat-disconnect
        $default: aux4 chat-message
```

## REST API

Routes are defined in `config.api` with the format `"METHOD /path"`. Path parameters use `{name}` syntax.

### Command Variables

Request data is automatically injected as command variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `${params.id}` | Path parameters | From `{id}` in route |
| `${query.search}` | Query string parameters | From `?search=...` |
| `${body.name}` | Request body fields | From form/JSON body |
| `${headers.authorization}` | Request headers | Any header |
| `${cookies.token}` | Request cookies | Any cookie |
| `${principal.email}` | Authenticated user info | From auth command |

Use `value()` for safe shell quoting: `value(params.id)`, `value(body)`.

### Event Format (stdin)

The full AWS API Gateway-style event is also piped to the command via stdin for backward compatibility.

### Response Format (stdout)

| Output | Behavior |
|--------|----------|
| JSON with `statusCode` | API Gateway response (status, headers, body) |
| JSON without `statusCode` | 200 with JSON body (or rendered partial if views exist) |
| Plain text | 200 with text body |
| `data:<mimetype>;base64,<data>` | Binary response with auto Content-Type |
| Command fails (non-zero exit) | 500 with generic error message |

### Route Options

```yaml
"GET /endpoint":
  command: aux4 my-command
  public: true              # skip authentication
  timeout: 60000            # override default timeout
  stream: true              # enable SSE streaming
  redirect: /other          # redirect after success
  setCookie:                # set cookie from response
    name: auth_token
    field: token
  clearCookie: auth_token   # clear a cookie
  rateLimit:                # per-route rate limiting
    max: 5
    timeWindow: 60000
  allowedIPs:               # per-route IP allowlist
    - 10.0.0.1
```

Routes without a `command` field can still use `clearCookie` and `redirect` (useful for logout):

```yaml
"POST /auth/logout":
  public: true
  clearCookie: auth_token
  redirect: /auth/signin
```

### Redirect

After a successful command, `redirect` executes the target route's command and returns its response. If the target has a matching partial template, it renders HTML.

## Authentication

Configure authentication in `security.auth`:

```yaml
config:
  security:
    auth:
      type: cookie          # cookie | bearer | apiKey | both
      command: aux4 auth validate
      cookie: auth_token    # cookie name (for cookie/both types)
      redirect: /auth/signin # render this partial on 401
```

### Auth Types

| Type | Description |
|------|-------------|
| `cookie` | Reads token from an httpOnly cookie |
| `bearer` | Reads token from `Authorization: Bearer <token>` header |
| `apiKey` | Static API key comparison (no command needed) |
| `both` | Cookie first, bearer fallback (default) |

### Cookie Auth

```yaml
security:
  auth:
    type: cookie
    command: aux4 auth validate
    cookie: auth_token
    redirect: /auth/signin
```

The auth command receives `--cookies` and `--headers` and should return a JSON object with user info (the principal) on success, or exit with non-zero on failure:

```json
{"email": "user@example.com"}
```

The principal is injected as `--principal` into route commands, accessible via `${principal.email}`.

### Cookie Management

Set cookies from command responses:

```yaml
"POST /auth/signin":
  command: aux4 auth signin
  public: true
  setCookie:
    name: auth_token
    field: token
  redirect: /contacts
```

The command returns `{"token": "UUID", "email": "user@example.com"}`. The API extracts the `token` field and sets it as an httpOnly cookie. In production mode, the `Secure` flag is added.

### API Key Auth

```yaml
security:
  auth:
    type: apiKey
    apiKey: my-secret-key
    header: X-API-Key
```

Uses timing-safe comparison. No principal is set for API key auth.

### Bearer Auth

```yaml
security:
  auth:
    type: bearer
    command: aux4 auth validate
```

Reads from `Authorization: Bearer <token>` header.

## Convention-Based Views

Handlebars templates in the `views/` directory are automatically registered as GET routes:

| File | Route | Layout |
|------|-------|--------|
| `views/index.hbs` | `GET /` | Yes |
| `views/about.hbs` | `GET /about` | Yes |
| `views/users/{id}.hbs` | `GET /users/:id` | Yes |
| `views/greet.p.hbs` | `GET /greet` | No |

- `.hbs` files render with the layout (`views/layouts/main.hbs`)
- `.p.hbs` files render as partials (no layout wrapper)
- `views/error.p.hbs` is used for error responses (not registered as a route)
- `{id}` segments in filenames/directories become path parameters
- `layouts/`, `partials/`, and `i18n/` directories are skipped

### Partial Auto-Rendering

When an API command returns JSON and a matching `.p.hbs` partial exists, the server renders it as HTML automatically. The convention maps command names to template paths:

| Command | Partial |
|---------|---------|
| `aux4 contacts list` | `views/contacts/list.p.hbs` |
| `aux4 contacts get` | `views/contacts/get.p.hbs` |
| `aux4 auth signin` | `views/auth/signin.p.hbs` |

The JSON response is available in the template as `data`:

```handlebars
{{#each data}}
  <tr><td>{{firstName}}</td><td>{{phone}}</td></tr>
{{/each}}
```

Clients requesting `Accept: application/json` receive raw JSON instead.

### SPA Catch-All

When `views/index.hbs` exists, unmatched GET requests (non-API, non-static) serve the index page. This supports client-side URL routing with `hx-push-url`.

## Error Handling

### Error Redirects

Configure redirects for specific HTTP status codes:

```yaml
config:
  security:
    auth:
      redirect: /auth/signin    # shorthand for 401 redirect
    errorRedirects:
      "404": /errors/not-found  # renders views/errors/not-found.p.hbs
      "500": /errors/server     # renders views/errors/server.p.hbs
```

### Error Templates

Error templates are checked in order:

1. **Error redirect** — configured redirect path renders a partial (returns 200)
2. **Status template** — `views/401.p.hbs`, `views/404.p.hbs`, etc.
3. **Generic template** — `views/error.p.hbs` (receives `statusCode`, `message`, `error`)
4. **JSON fallback** — structured JSON for `Accept: application/json`

### Error Suppression

Command failures (non-zero exit) return a generic `500 Internal Server Error` message. Internal details (stderr, stack traces) are never exposed to clients.

## Static File Serving

Files in the `static/` directory are served at `/static/`:

```
static/css/app.css → http://localhost:8080/static/css/app.css
```

### Uploads Directory

Configure a directory for user-uploaded files:

```yaml
config:
  server:
    media: ./media
```

Files are served at `/media/`:

```
media/photo.jpg → http://localhost:8080/media/photo.jpg
```

## Production Mode

Enable with `--production true` in config:

```yaml
config:
  production: true
```

Production mode enables:
- `Secure` flag on cookies (requires HTTPS)
- Template caching without filesystem checks (faster, requires restart for changes)

Development mode (default):
- No `Secure` flag (cookies work on HTTP localhost)
- Template caching with mtime check (edit templates, see changes immediately)

## Components

Components are reusable, mountable web modules. Each component is a self-contained package with commands, routes, and views that can be plugged into any aux4/api application.

### Component Structure

A component is an aux4 package with views and a config:

```
components/aux4/contacts/
  .aux4              # commands
  config.yaml        # routes (relative paths)
  views/
    list.p.hbs       # partials
    get.p.hbs
    new.p.hbs
    edit.p.hbs
```

### Component Config

The component's `config.yaml` defines routes relative to its root:

```yaml
api:
  "GET /":
    command: aux4 contacts list
  "GET /{id}":
    command: aux4 contacts get
  "POST /":
    command: aux4 contacts create
    redirect: /
```

### Mounting Components

The host app mounts components at a path in its `config.yaml`:

```yaml
config:
  components:
    /contacts:
      package: aux4/contacts
    /chat:
      package: aux4/chat
      config:
        maxMessages: 100
```

Routes are automatically prefixed with the mount path. `GET /` in the contacts component becomes `GET /contacts` in the host app. Redirects are prefixed too.

### Installing Components

Install all components listed in config:

```bash
aux4 api init
```

Or install individually:

```bash
aux4 api package install aux4/contacts
```

The `init` command:
1. Downloads packages from hub.aux4.io (if not already installed)
2. Copies component files to `./components/<scope>/<name>/`
3. Merges component command profiles into the host `.aux4`

### Managing Components

```bash
aux4 api package list          # list installed components
aux4 api package uninstall aux4/contacts  # remove a component
```

### Template Variables

Component partials receive `{{apiPath}}` and `{{basePath}}` for building links:

- `{{apiPath}}` — the API route prefix (e.g., `/api/contacts`) for `hx-get`, `hx-post`, etc.
- `{{basePath}}` — the page route prefix (e.g., `/contacts`) for `hx-push-url` and `href`

Inside `{{#each}}` loops, use `{{../apiPath}}` and `{{../basePath}}`.

```handlebars
<a href="{{../basePath}}/{{id}}" hx-get="{{../apiPath}}/{{id}}" hx-target="#app">
  {{firstName}} {{lastName}}
</a>
```

### Embedding Components

Use `<aux4-component>` to embed components in any page. The custom element is auto-injected when components are configured.

```html
<!-- Load the full component with URL routing -->
<aux4-component src="/contacts" route="true"></aux4-component>

<!-- Load a specific view -->
<aux4-component src="/contacts/card" id="abc123"></aux4-component>

<!-- Multiple components on one page -->
<aux4-component src="/contacts" route="true"></aux4-component>
<aux4-component src="/chat/messages" room="general"></aux4-component>
```

Attributes:
- `src` — the component path (automatically prefixed with `/api/`)
- `route="true"` — use the current page URL path instead of the static `src` (for SPA-style routing)
- Any other attribute — passed as query parameters to the API

The component fetches HTML from the API, renders it, and processes HTMX attributes automatically. No JavaScript needed per component.

### How It Works

1. **On startup**, aux4/api reads `config.components`, loads each component's `config.yaml`, prefixes routes, and merges them into the API
2. **Component views** are resolved from `components/<scope>/<name>/views/` for partial rendering
3. **`<aux4-component>`** is auto-injected as a `<script>` tag before `</body>` in all HTML pages
4. **Authentication** flows through the host app's `security.auth` — components receive `${principal}` automatically
5. **On page load**, each `<aux4-component>` fetches its content from the API and renders it

## WebSocket Support

WebSocket routes are defined in `config.ws`. Each path maps lifecycle events and custom actions to commands.

### Route Keys

- `$connect` — fired when a client connects
- `$disconnect` — fired when a client disconnects
- `$default` — fired when no matching action is found
- `<action>` — custom action matched from `{ "action": "<action>" }` in the message body

### Management API

- `POST /@connections/:connectionId` — send a message to a specific connection
- `DELETE /@connections/:connectionId` — disconnect a specific connection

## SSE Streaming

Routes with `stream: true` use Server-Sent Events:

```yaml
config:
  api:
    "GET /stream":
      command: aux4 my-stream
      stream: true
```

Each stdout line is sent as `data: <line>\n\n`. On exit, `event: done` is sent.

## Rate Limiting

Global and per-route rate limiting with sliding window by client IP:

```yaml
config:
  security:
    rateLimit:
      max: 100
      timeWindow: 60000
  api:
    "POST /login":
      command: aux4 login
      rateLimit:
        max: 5
        timeWindow: 60000
```

Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

## IP Allowlist

```yaml
config:
  security:
    allowedIPs:
      - 127.0.0.1
      - 192.168.1.0/24
  api:
    "GET /admin":
      command: aux4 admin
      allowedIPs:
        - 10.0.0.1
```

Per-route `allowedIPs` replaces the global list. Behind a reverse proxy, set `server.trustProxy: true`.

## HTTPS/TLS

```yaml
config:
  tls:
    key: path/to/key.pem
    cert: path/to/cert.pem
```

## Environment Variables

- `AUX4_API_PORT` — override the port (takes precedence over config file)
