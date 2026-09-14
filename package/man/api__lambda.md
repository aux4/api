#### Description

The `lambda` command runs one API Gateway event and emits the Lambda integration
response as JSON to **stdout**. REST proxy events use the **full Fastify
application**, including static files, convention-based Handlebars views, and
binary downloads. API Gateway WebSocket v2 events dispatch directly to
`config.ws` commands because API Gateway—not the Lambda process—owns the
persistent socket. Structured Cloud workflow events keep their separate direct
execution path.

It reads one event as JSON on **stdin**, runs it through the app, and writes the proxy response to **stdout**:

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

Use this as the AWS Lambda entrypoint when deploying a multi-route aux4/api app as a container image behind API Gateway and the app serves more than plain REST (static assets, views, file downloads). For a REST-only app that wants the smallest possible cold start, `api handle` is lighter.

- **URL layout** — REST routes are served under `/api/`, static assets under `/static/`, and views at the root — identical to `api start`. Incoming event paths must include those prefixes (`/api/contacts`, `/static/logo.png`), because the full app matches the path verbatim (no implicit `/api` prepend).
- **Event shape** — API Gateway **REST API (v1) / payload format 1.0**: `httpMethod`, `path`, flat `headers`, `queryStringParameters`, `body`, `isBase64Encoded`, `requestContext.identity.sourceIp`.
- **Warm reuse** — the Fastify app is built **once** per container and cached, then reused across invocations (no per-request rebuild). This is the key difference from `api handle`, which routes in-process per event.
- **Warm package handlers** — trusted REST route and bearer/cookie validator
  modules are loaded from an installed package and cached by package and
  configuration identity. They share command concurrency/timeout limits and
  return the same `{ exitCode, stdout, stderr }` envelope, preserving response
  and timing-relay semantics. Module paths are package-relative and cannot come
  from request data.
- **Response contract** — same as `api start`: a command that emits JSON with a `statusCode` produces that gateway response; plain JSON is wrapped as `200 application/json`; a `data:<mime>;base64,...` (or otherwise binary) response is returned with `isBase64Encoded: true` and its `Content-Disposition` preserved so a file download survives API Gateway.
- **Binary downloads** — because binary responses come back base64-encoded, the API Gateway must set `binaryMediaTypes = ["*/*"]` so it decodes the base64 back to bytes for the client. The base64 decision is made from the response `Content-Type`: text-ish types (`text/*`, `application/json|javascript|xml`, `image/svg`) pass through as UTF-8; everything else is treated as binary.
- **WebSocket event shape** — API Gateway WebSocket v2 events include
  `requestContext.routeKey`, `eventType`, `connectionId`, `domainName`, and
  `stage`. `$connect`, `$disconnect`, `$default`, and custom route keys map to
  commands in `config.ws`.
- **WebSocket replies** — message command output uses the signed API Gateway
  Management API by default. The Lambda role needs
  `execute-api:ManageConnections`. Set `responseMode: route` to return the body
  through an enabled API Gateway route response, or `responseMode: none` when the
  command performs its own delivery.
- **WebSocket authentication** — configure the API Gateway authorizer on
  `$connect`. Authorizer context is forwarded to the connect command. Without a
  gateway principal, `security.auth` is evaluated on `$connect`. Persist a
  connection-to-principal mapping in the connect command if later message
  commands need identity because API Gateway authorizers run only at connection
  time.

##### Structured Cloud workflows

The Cloud VM's long-lived runtime also accepts trusted `aux4.execution.v1`
workflow events. It checks the execution grant's command prefix on every phase,
reuses valid grants for at most five minutes (60 seconds before credential or
execution expiry), and drops the grant after a final result. Grants are never
persisted. Both credential and execution expiry must be valid numeric timestamps;
missing or invalid information for either disables reuse. A 401 or 403
from the read-only grant exchange permits one retry; failed commands are never
replayed automatically. Pre/post synchronization preserves the checkpoint
barrier before the next workflow phase.

Runtime stderr includes `aux4.timing` JSON records for `sync.pre`, `grant.cache`,
`grant.fetch`, `command.validation`, `command.execution`, `sync.post`,
`completion` (final results), and `phase.total`. Each record contains a safe
`traceId`, fixed phase/span labels, `durationMs`, `status`, `cacheHit`, and
`cold` (first structured execution in this container). No arguments, prompts,
command output, tokens, or machine keys appear in these records. Child commands
receive `AUX4_TRACE_ID` and `AUX4_EXECUTION_PHASE`; only matching valid child
spans are copied to the runtime log, leaving command output unchanged. An
event's `traceId` (or `X-Aux4-Trace-Id` header) is accepted only as 32 lowercase
hexadecimal characters; otherwise the runtime hashes its execution id.

##### WebSocket configuration

```yaml
config:
  ws:
    "/chat":
      responseMode: management
      routes:
        $connect: aux4 chat connect
        $disconnect: aux4 chat disconnect
        $default: aux4 chat message
        sendMessage: aux4 chat send
```

One `config.ws` entry is selected automatically. With multiple entries, set the
WebSocket stage variable `AUX4_WS_PATH` to the desired path. The default callback
URL comes from `requestContext.domainName` and `stage`; custom domains omit the
stage. `managementEndpoint` can override the callback URL when necessary.

The in-process route contract does not replace WebSocket transport behavior.
Fastify continues to own Upgrade sockets under `api start`; API Gateway sends
discrete WebSocket events to Lambda, where configured `config.ws` commands run
without booting Fastify.

##### Limitations

The Lambda adapter does not provide a persistent HTTP server, so these features
still need `aux4 api start`:

- **SSE streaming** routes (`stream: true`)
- **Multipart uploads** (`multipart/form-data`)

#### Usage

```bash
aux4 api lambda --configFile <config.yaml> < event.json
```

--configFile   Path to the config file whose `config.api` defines the routes (also populates `cors`, `ws`, `server`, `tls`, `security`, `production`, `components`)

The event is read from stdin; the proxy response is written to stdout.

#### Example

Configuration file:

```yaml
config:
  api:
    "GET /report":
      command: aux4 reports export
```

```bash
echo '{
  "httpMethod": "GET",
  "path": "/api/report",
  "headers": {},
  "body": null,
  "isBase64Encoded": false,
  "requestContext": { "identity": { "sourceIp": "1.2.3.4" } }
}' | aux4 api lambda --configFile config.yaml
```

```json
{
  "statusCode": 200,
  "headers": {
    "content-type": "application/pdf",
    "content-disposition": "attachment; filename=\"report.pdf\""
  },
  "body": "JVBERi0xLjQK...",
  "isBase64Encoded": true
}
```
