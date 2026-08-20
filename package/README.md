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

### Route Matching

| Syntax | Matches | Captured as |
|--------|---------|-------------|
| `GET /users` | Exact method + path | — |
| `GET /users/{id}` | A single path segment (no `/`) | `${params.id}` |
| `ANY /users/{id}` | Any HTTP method for that path | `${params.id}` |
| `GET /files/{path...}` | The rest of the path, **including** slashes (greedy) | `${params.path}` |
| `ANY /{path...}` | **Every** method and **every** path (full catch-all) | `${params.path}` |

- **Wildcard method** — use `ANY` (or `*`) as the method to match every HTTP method (`GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `OPTIONS`, and auto-`HEAD`) for the given path.
- **Greedy catch-all path** — append `...` inside a path parameter (`{path...}`) to capture the remaining path segments, slashes and all. A plain `{name}` still matches exactly one segment. The captured value is available to the command as a normal path parameter (e.g. `${params.path}` / `.pathParameters.path` in the stdin event).
- **Matching priority** — specific routes always win over catch-alls regardless of the order they are declared. An exact method beats `ANY`, and a single-segment `{name}` route beats a greedy `{path...}` route. Among equally-specific routes, declaration order is preserved. This lets you declare `GET /health` alongside `ANY /{path...}` and have `/health` still reach its own command while everything else falls through to the catch-all.

To mount a single command that serves **every method on every path** (e.g. a programmable mock), use:

```yaml
config:
  api:
    "ANY /{path...}":
      command: aux4 my-handler respond
      public: true
```

The command receives the method via the stdin event's `httpMethod` (also `requestContext.httpMethod`) and the full request path via `--params` as `{"path":"the/rest/of/the/path"}` (i.e. `${params.path}`, or `.pathParameters.path` in the event). The original path is also on the event as `path` and `requestContext.path`.

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

### Request Body & Content-Types

The server accepts a request body for **any** content-type and delivers it to the command — it never rejects a request at the content-type layer. This makes it a faithful HTTP -> CLI bridge, so a mounted command sees every request regardless of how the client framed it.

| Content-Type | Handling |
|--------------|----------|
| `application/json` | Parsed to an object; injected as `${body.field}`. An **empty body** is accepted (no `400`) and delivered as no body — real APIs accept this shape (e.g. an endpoint whose data rides in the query string). A non-empty body that is not valid JSON still returns `400`. |
| `application/x-www-form-urlencoded` | Parsed into fields; injected as `${body.field}`. |
| `multipart/form-data` | Files streamed to a temp dir; fields and file metadata injected as `${body.field}`. |
| `text/plain` | Delivered verbatim as the raw body. |
| Any other type (e.g. `multipart/related`, `application/octet-stream`) **or no `Content-Type` header** | The raw body is captured as a UTF-8 string and delivered verbatim on the event as `body` (`isBase64Encoded` stays `false`). |

**Note:** the raw catch-all path captures the body as a UTF-8 string, so a truly binary payload sent under an unregistered content-type may be lossy. Text bodies (including `multipart/related` with JSON + text parts, as produced by `aux4 curl --upload`) are preserved exactly.

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
  openapi:                  # OpenAPI operation overrides (see OpenAPI section)
    summary: My endpoint
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

## OpenAPI

Generate an [OpenAPI 3.0.3](https://spec.openapis.org/oas/v3.0.3) document from your `config.api` (plus any mounted components) with:

```bash
aux4 api openapi --configFile config.yaml            # JSON to stdout
aux4 api openapi --configFile config.yaml --format yaml
```

Every `"METHOD /path"` route key becomes an OpenAPI path item and operation:

- `{name}` path segments become required `string` path parameters.
- `operationId` and `summary` are derived from the route's `command` (e.g. `aux4 auth signin` → `aux4_auth_signin`).
- Operations are tagged by the first path segment (`/contacts/{id}` → `contacts`).
- Component routes from `config.components` are merged under their mount paths, exactly as the running server resolves them.
- `config.info` (`title`, `version`, `description`) populates the OpenAPI `info` block. Defaults: `aux4 API` / `1.0.0`.

### Parameter inference

As a best effort, the command's `execute[]` (looked up in the app `.aux4` beside the config file) is statically scanned:

- `${query.X}` references → `string` query parameters (on `GET`/`DELETE`).
- Body-field references → `requestBody` properties (on `POST`/`PUT`/`PATCH`). Fields are found via `${body.X}` and via aliases created with `set:alias=json:${body}`, e.g. `object(data.firstName:firstName, ...)`.

Inference is a heuristic and only sees fields the static scan can reach; everything else should be declared with the `openapi:` annotation below.

### The `openapi:` annotation

Any route entry may carry an `openapi:` block that is overlaid onto the generated operation — the reliable escape hatch for anything inference cannot derive:

```yaml
config:
  api:
    "GET /search":
      command: aux4 search run
      openapi:
        summary: Search records
        tags:
          - search
        parameters:
          - name: q
            in: query
            required: true
            schema:
              type: string
        responses:
          "200":
            description: Matching records
          "400":
            description: Bad query
```

Overlay rules:

- `summary`, `description`, `operationId`, `deprecated`, `tags` — **replace** the generated value.
- `parameters` — **merged** by `in`+`name` (annotation wins, new params appended).
- `requestBody` — **replaces** the generated request body.
- `responses` — **shallow-merged** onto the generated `200`.

## Single-Event Handling (Lambda)

`aux4 api handle` runs one **API Gateway REST v1 proxy event** through the same routing engine as `api start`, but **in-process** — no HTTP server, no socket. It reads the event as JSON on stdin and writes an API Gateway proxy response as JSON to stdout:

```bash
echo '{ "httpMethod": "GET", "path": "/contacts", "headers": {}, "body": null, "isBase64Encoded": false, "requestContext": { "identity": { "sourceIp": "1.2.3.4" } } }' \
  | aux4 api handle --configFile config.yaml
```

```json
{
  "statusCode": 200,
  "headers": {
    "content-type": "application/json"
  },
  "body": "[{\"id\":\"1\",\"name\":\"Alice\"}]",
  "isBase64Encoded": false
}
```

This is the one-event-per-invocation entrypoint the AWS Lambda runtime calls when running a multi-route aux4/api app as a container image behind API Gateway. It reuses the same routing, authentication, rate-limiting, cookie, redirect, and response-shaping logic as the running server, so a single deployed function can serve every route in `config.api`.

- **Event shape** — API Gateway **REST API (v1) / payload format 1.0**: `httpMethod`, `path`, flat `headers`, `queryStringParameters` / `multiValueQueryStringParameters`, `body`, `isBase64Encoded`, `requestContext.identity.sourceIp`. `pathParameters` are recomputed by matching `path` against the route patterns.
- **Response contract** — identical to the server: a command that emits JSON with a `statusCode` produces that gateway response; plain JSON is wrapped as `200 application/json`; `data:`/binary output is base64-encoded with `isBase64Encoded: true`; `Set-Cookie` is emitted (multiple cookies via `multiValueHeaders`).
- **Base64 bodies** — an `isBase64Encoded: true` request body is decoded before routing.

**Note:** streaming (`stream: true`, SSE), multipart uploads (`multipart/form-data`), and WebSocket routes require a live socket and are **not supported** through `api handle` — they are rejected with `501` / `415`. Use `aux4 api start` for those transports.

CORS is honored on this path too — see [CORS](#cors) below.

### Full-App Lambda (`api lambda`)

`aux4 api handle` is routing-only: it never boots Fastify, so `@fastify/static`, convention-based views, and multipart parsing are not available. When you need the **whole application** behind API Gateway — REST **plus** static files, Handlebars views, and binary downloads — use `aux4 api lambda`.

`api lambda` builds the same Fastify app as `api start` (all plugins registered) and wraps it with [`@fastify/aws-lambda`](https://github.com/fastify/aws-lambda-fastify), so one warm Lambda container serves every route. It reads a single API Gateway proxy event on stdin and writes the proxy response to stdout, just like `api handle`:

```bash
echo '{ "httpMethod": "GET", "path": "/static/logo.png", "headers": {}, "body": null, "isBase64Encoded": false, "requestContext": { "identity": { "sourceIp": "1.2.3.4" } } }' \
  | aux4 api lambda --configFile config.yaml
```

- **URL layout** — REST routes live under `/api/`, static assets under `/static/`, and views at the root — the same split as `api start`. Clients call `/api/...` for the API and `/static/...` for assets.
- **Static files and downloads work** — a `data:<mime>;base64,...` (or otherwise binary) response is returned with `isBase64Encoded: true` so the file survives API Gateway intact. Pair the gateway with `binaryMediaTypes = ["*/*"]` so it decodes the base64 back to bytes on the way out.
- **Warm reuse** — the app is built once per container and reused across invocations (no per-request rebuild), unlike `api handle`.

**Note:** WebSocket routes, SSE streaming (`stream: true`), and multipart **uploads** need a live socket and are not available through `api lambda` either — use `aux4 api start` for those. Use `api handle` when you only need REST routing with the smallest cold start; use `api lambda` when the app also serves static files or downloads.

## CORS

`config.cors` configures Cross-Origin Resource Sharing and applies to **both** `api start` and `api handle`. On `api start` the headers are applied by `@fastify/cors`; on `api handle` (which never runs Fastify) the same headers are computed in-process. When `config.cors` is absent or empty, no `Access-Control-*` headers are emitted.

```yaml
config:
  cors:
    origin:
      - https://aux4.io
      - http://localhost:5173
    methods:
      - GET
      - POST
      - PUT
      - DELETE
      - PATCH
      - OPTIONS
    allowedHeaders:
      - Content-Type
      - Authorization
    exposedHeaders:
      - X-Total-Count
    credentials: true
    maxAge: 600
```

| Field | Type | Behavior |
|-------|------|----------|
| `origin` | `"*"` | Allow any origin — emits `Access-Control-Allow-Origin: *` with no `Vary`. |
| `origin` | string | A single allowed origin — the request `Origin` is echoed (with `Vary: Origin`) only when it matches. |
| `origin` | array | Allowlist — the request `Origin` is echoed (with `Vary: Origin`) only when it is a member. Each entry is matched independently, so multiple URLs (e.g. a production domain plus local dev servers) are all allowed. |
| `origin` | `true` | Reflect the request `Origin` back (with `Vary: Origin`). |
| `origin` | `false` | CORS disabled. |
| `methods` | string/array | `Access-Control-Allow-Methods` on the preflight (default `GET,POST,PUT,DELETE,PATCH,OPTIONS`). |
| `allowedHeaders` | string/array | `Access-Control-Allow-Headers` on the preflight. When unset, the browser's `access-control-request-headers` is reflected. |
| `exposedHeaders` | string/array | `Access-Control-Expose-Headers` on the actual response. |
| `credentials` | boolean | When `true`, adds `Access-Control-Allow-Credentials: true`. |
| `maxAge` | number | `Access-Control-Max-Age` (seconds) on the preflight only. |

An `OPTIONS` preflight from an allowed origin is answered with `204 No Content` and the preflight header set; the mapped command does not run. Actual responses carry `Access-Control-Allow-Origin` (plus `Access-Control-Allow-Credentials` / `Access-Control-Expose-Headers` when configured) but never the preflight-only `Allow-Methods` / `Allow-Headers` / `Max-Age`.

**Credentials + wildcard:** the Fetch spec forbids `Access-Control-Allow-Credentials: true` alongside `Access-Control-Allow-Origin: *`. When `credentials: true` and `origin` resolves to `*`, the request `Origin` is reflected (with `Vary: Origin`) instead of `*`, so credentialed cross-origin requests succeed.

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
| `oauth` | Full OAuth2/OIDC web-login flow with a signed session cookie |

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

### Auth Caching

Auth validation results are cached in memory for 1 minute per token, avoiding repeated command execution for the same session. Configure the TTL:

```yaml
security:
  auth:
    cacheTTL: 60000   # milliseconds (default: 60000)
```

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

### OAuth Web Login

`type: oauth` enables a full server-side OAuth2/OIDC login flow. The API handles the browser redirect dance, exchanges the authorization code through the `aux4 oauth` commands, and issues its own signed session cookie. Per-request authentication then verifies that session cookie in-process (no subprocess) and injects the principal into route commands. Works with any OAuth2/OIDC provider.

```yaml
security:
  auth:
    type: oauth
    session:
      secret: "secret://session-secret"   # HMAC secret for the session JWT
      cookie: auth_token                   # session cookie name (default: auth_token)
      ttl: 86400                           # session lifetime in seconds (default: 86400)
    redirectAfterLogin: /                  # where to send the user after a successful login
    redirectOnError: /login                # where to send the user on login failure / 401 (optional)
    providers:
      google:
        clientId: "..."
        clientSecret: "secret://google-client-secret"
        redirectUri: https://app.example.com/auth/callback
        # optional, for non-bundled providers:
        authUrl: https://accounts.google.com/o/oauth2/v2/auth
        tokenUrl: https://oauth2.googleapis.com/token
        userinfoUrl: https://openidconnect.googleapis.com/v1/userinfo
        scopes: openid,email,profile
        map: { "id": "sub" }               # optional userinfo->principal field map
```

When `type: oauth` is set, the API auto-wires three routes:

| Route | Behavior |
|-------|----------|
| `GET /auth/signin?provider=<name>` | Builds the provider authorize URL (PKCE S256), stashes `{codeVerifier, state, provider}` in a short-lived signed httpOnly cookie, and `302`s to the provider. `provider` defaults to the sole configured provider when omitted. |
| `GET /auth/callback?code&state` | Reads and clears the temp cookie, verifies `state`, exchanges the code for a principal, mints an HS256 session JWT (claims = principal + `exp`), sets it as the session cookie, and redirects to `redirectAfterLogin`. On any failure it redirects to `redirectOnError`. |
| `GET /auth/logout` | Clears the session cookie and redirects (defaults to `redirectOnError`; override with `?redirect=/path`). |

The PKCE state lives entirely in a signed, short-lived cookie — there is no server-side session store. The session cookie is an HS256 JWT signed and verified with `session.secret` using node's built-in crypto (no JWT library dependency). On every protected request the JWT signature and expiry are checked in-process, and the decoded claims are injected as `--principal` (accessible via `${principal.email}`, `${principal.sub}`, etc.). Missing, invalid, or expired session cookies return `401` (browsers are redirected to `redirectOnError`).

Cookies are `httpOnly` with `SameSite=Lax`, and gain the `Secure` flag in production mode. The provider's `clientSecret` and access tokens are never logged or stored in the session.

**Requires** the `aux4/oauth` package to be installed (it provides `aux4 oauth authorize-url` and `aux4 oauth exchange`).

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

### Handlebars Helpers

Built-in helpers available in all templates:

| Helper | Usage | Description |
|--------|-------|-------------|
| `eq` | `{{#if (eq mode "edit")}}` | Equality comparison |
| `ne` | `{{#if (ne status "draft")}}` | Not-equal comparison |
| `fileSize` | `{{fileSize size}}` | Human-readable file size (e.g., `38.8 KB`) |

#### Custom Helpers

Add custom helpers by creating a `helpers/` directory. Each `.js` file becomes a helper named after the filename:

```
helpers/
  uppercase.js   → {{uppercase name}}
  formatDate.js  → {{formatDate createdAt}}
```

Each file exports a single function:

```js
// helpers/uppercase.js
module.exports = function(str) {
  return (str || "").toUpperCase();
};
```

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
6. **Batch loading** — multiple components on a page are batched into a single `/aux4/batch` request
7. **Placeholders** — empty components show a Bootstrap placeholder skeleton while loading

### Batch Loading

When multiple `<aux4-component>` elements exist on a page, their requests are batched into a single POST to `/aux4/batch` (10ms debounce). This reduces the number of HTTP requests from N to 1.

The batch endpoint:
- Max 20 URLs per request
- Only `/api/` paths allowed
- Auth flows through from the original request

### Command Namespacing

Components should use the `api:module` profile to avoid command name collisions:

```json
{
  "name": "api:module",
  "commands": [{
    "name": "files",
    "execute": ["profile:api:module:files"]
  }]
}
```

Commands are accessed via `aux4 api module files list`. The `api:module` profile is provided by aux4/api.

### Binary Downloads

Commands can return binary data via data URIs. By default, files are downloaded (not opened in browser):

```
data:application/pdf;filename=report.pdf;base64,JVBERi0xLjQ...
```

To open in browser instead of downloading, add `inline`:

```
data:image/png;inline;filename=photo.png;base64,iVBORw0KGgo...
```

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
