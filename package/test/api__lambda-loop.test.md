# api lambda-loop

The long-lived Lambda runtime loop builds the Fastify app ONCE and owns the AWS
Lambda runtime API loop, reusing the warm app across every invocation. Before a
stateful app action (a route whose path contains `/action/`) it pulls fresh state so
a warm sibling container never serves a stale conversation store; after the response
is posted it pushes state. Both are best-effort and off the response path.

These tests drive `aux4 api lambda-loop` against a MOCK AWS Lambda runtime API and a
MOCKED cloud-file-sync engine module (`AUX4_LAMBDA_PRE_INVOKE_MODULE`), asserting the
pull ordering, the route gating, TTL coalescing, and best-effort failure handling. No
inference or real state sync runs — fixtures only.

The shared `order.log` records the sequence: the mocked `pullFromEnv` appends `pull`
when it runs; the mock runtime appends `resp` when it receives a handler response.
`AUX4_LAMBDA_MAX_INVOCATIONS` bounds the loop so each run exits after the events are
served. The command daemon is disabled (`AUX4_API_NO_COMMAND_DAEMON=1`); unmatched
routes return 404, which is still a real handler response. Each test starts its own
mock runtime on a unique port and tears it down at the end.

## warm-container state sync barrier

```file:config.yaml
config:
  api: {}
```

```file:mock-runtime.mjs
import http from "http";
import { readFileSync, appendFileSync, statSync } from "fs";

const port = parseInt(process.argv[2] || "19147", 10);
const EVENTS = "events.jsonl";
const ORDER = "order.log";

// Serve events from events.jsonl in order; each test writes its own file and its own
// port, so the queue is fresh per case.
let idx = 0;

function nextEvent() {
  let lines;
  try {
    lines = readFileSync(EVENTS, "utf8").split("\n").filter(l => l.trim());
  } catch {
    return null;
  }
  if (idx >= lines.length) return null;
  return lines[idx++];
}

const server = http.createServer((req, res) => {
  const url = req.url || "";
  if (req.method === "GET" && url.endsWith("/invocation/next")) {
    const ev = nextEvent();
    if (ev == null) return; // no more events: hang (the loop is bounded, never reaches here)
    res.setHeader("lambda-runtime-aws-request-id", "req-" + idx);
    res.statusCode = 200;
    res.end(ev);
    return;
  }
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    if (url.endsWith("/response")) {
      try { appendFileSync(ORDER, "resp\n"); } catch {}
    } else if (url.includes("/error")) {
      try { appendFileSync(ORDER, "error\n"); } catch {}
    }
    res.statusCode = 202;
    res.end("{}");
  });
});

server.listen(port, "127.0.0.1", () => console.log("mock runtime on " + port));
```

```file:stub-ok.mjs
import { appendFileSync } from "fs";

// Mock of cloud-file-sync sync-engine.mjs: records that the in-process pull ran.
export async function pullFromEnv() {
  appendFileSync("order.log", "pull\n");
  return { ok: true };
}

export async function pushFromEnv() {
  return { ok: true };
}
```

```file:stub-throw.mjs
// Mock engine whose pull throws — the pre-invoke pull must swallow it and let the
// request proceed (best-effort barrier, never aborts the request).
export async function pullFromEnv() {
  throw new Error("boom pull");
}

export async function pushFromEnv() {
  return { ok: true };
}
```

### should pull fresh state BEFORE the handler for an /action/ path

```file:events.jsonl
{"httpMethod":"GET","path":"/action/say","pathParameters":{"proxy":"action/say"},"headers":{},"body":null,"isBase64Encoded":false,"requestContext":{"identity":{"sourceIp":"1.2.3.4"}}}
```

```timeout
30000
```

```execute
rm -f order.log; nohup node mock-runtime.mjs 19147 >/dev/null 2>&1 & MOCK=$!; sleep 1; AUX4_API_NO_COMMAND_DAEMON=1 AUX4_LAMBDA_MAX_INVOCATIONS=1 AWS_LAMBDA_RUNTIME_API=127.0.0.1:19147 AUX4_LAMBDA_PRE_INVOKE_MODULE="$PWD/stub-ok.mjs" AUX4_LAMBDA_PRE_INVOKE_TTL_MS=0 aux4 api lambda-loop --configFile config.yaml >/dev/null 2>&1; kill $MOCK 2>/dev/null; cat order.log
```

```expect
pull
resp
```

### should NOT pull for a non-action path (/api/me)

```file:events.jsonl
{"httpMethod":"GET","path":"/api/me","pathParameters":{"proxy":"api/me"},"headers":{},"body":null,"isBase64Encoded":false,"requestContext":{"identity":{"sourceIp":"1.2.3.4"}}}
```

```timeout
30000
```

```execute
rm -f order.log; nohup node mock-runtime.mjs 19148 >/dev/null 2>&1 & MOCK=$!; sleep 1; AUX4_API_NO_COMMAND_DAEMON=1 AUX4_LAMBDA_MAX_INVOCATIONS=1 AWS_LAMBDA_RUNTIME_API=127.0.0.1:19148 AUX4_LAMBDA_PRE_INVOKE_MODULE="$PWD/stub-ok.mjs" AUX4_LAMBDA_PRE_INVOKE_TTL_MS=0 aux4 api lambda-loop --configFile config.yaml >/dev/null 2>&1; kill $MOCK 2>/dev/null; cat order.log
```

```expect
resp
```

### should coalesce a second immediate action pull within the TTL

```file:events.jsonl
{"httpMethod":"GET","path":"/action/one","pathParameters":{"proxy":"action/one"},"headers":{},"body":null,"isBase64Encoded":false,"requestContext":{"identity":{"sourceIp":"1.2.3.4"}}}
{"httpMethod":"GET","path":"/action/two","pathParameters":{"proxy":"action/two"},"headers":{},"body":null,"isBase64Encoded":false,"requestContext":{"identity":{"sourceIp":"1.2.3.4"}}}
```

```timeout
30000
```

```execute
rm -f order.log; nohup node mock-runtime.mjs 19149 >/dev/null 2>&1 & MOCK=$!; sleep 1; AUX4_API_NO_COMMAND_DAEMON=1 AUX4_LAMBDA_MAX_INVOCATIONS=2 AWS_LAMBDA_RUNTIME_API=127.0.0.1:19149 AUX4_LAMBDA_PRE_INVOKE_MODULE="$PWD/stub-ok.mjs" AUX4_LAMBDA_PRE_INVOKE_TTL_MS=60000 aux4 api lambda-loop --configFile config.yaml >/dev/null 2>&1; kill $MOCK 2>/dev/null; cat order.log
```

```expect
pull
resp
resp
```

### should not abort the request when the pull throws

```file:events.jsonl
{"httpMethod":"GET","path":"/action/say","pathParameters":{"proxy":"action/say"},"headers":{},"body":null,"isBase64Encoded":false,"requestContext":{"identity":{"sourceIp":"1.2.3.4"}}}
```

```timeout
30000
```

```execute
rm -f order.log; nohup node mock-runtime.mjs 19150 >/dev/null 2>&1 & MOCK=$!; sleep 1; AUX4_API_NO_COMMAND_DAEMON=1 AUX4_LAMBDA_MAX_INVOCATIONS=1 AWS_LAMBDA_RUNTIME_API=127.0.0.1:19150 AUX4_LAMBDA_PRE_INVOKE_MODULE="$PWD/stub-throw.mjs" AUX4_LAMBDA_PRE_INVOKE_TTL_MS=0 aux4 api lambda-loop --configFile config.yaml >/dev/null 2>&1; kill $MOCK 2>/dev/null; cat order.log
```

```expect
resp
```
