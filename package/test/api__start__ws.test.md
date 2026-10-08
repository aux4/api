# api start websocket

```file:config.yaml
config:
  port: 18711
  ws:
    "/ws":
      routes:
        $default: aux4 ws-echo
        echo: aux4 ws-echo
    "/wsstream":
      stream: true
      command: aux4 apitest ws-echo-stdin
      idleTimeout: 10000
      maxDuration: 10000
```

```file:.aux4
{
  "profiles": [
    {
      "name": "main",
      "commands": [
        {
          "name": "ws-echo",
          "execute": [
            "stdin:jq -rc '{statusCode: 200, body: ({echo: ((.body | fromjson).message // \"no message\"), route: .requestContext.routeKey} | tostring)}'"
          ],
          "help": {
            "text": "WS echo"
          }
        },
        {
          "name": "apitest",
          "execute": [
            "profile:apitest"
          ],
          "help": {
            "text": "API test fixture commands"
          }
        }
      ]
    },
    {
      "name": "apitest",
      "commands": [
        {
          "name": "ws-echo-stdin",
          "execute": [
            "stdin:cat"
          ],
          "help": {
            "text": "Echo stdin frames back to stdout, for the WS stream-session test",
            "variables": [
              { "name": "query", "text": "Query JSON", "default": "" },
              { "name": "headers", "text": "Headers JSON", "default": "" },
              { "name": "principal", "text": "Principal JSON", "default": "" }
            ]
          }
        }
      ]
    }
  ]
}
```

```file:ws-client.js
const W = require("ws");
const action = process.argv[2];
const t = setTimeout(() => { process.exit(1); }, 3000);
const w = new W("ws://localhost:18711/ws");
w.on("open", () => {
  if (action === "connect") { console.log("connected"); w.close(); }
  else if (action === "echo") { w.send(JSON.stringify({ action: "echo", message: "hello ws" })); }
  else if (action === "default") { w.send(JSON.stringify({ message: "fallback" })); }
});
w.on("message", (d) => { console.log(d.toString()); w.close(); });
w.on("close", () => { clearTimeout(t); process.exit(0); });
w.on("error", (e) => { console.error("ws error:", e.message); clearTimeout(t); process.exit(1); });
```

```file:ws-stream-client.js
const W = require("ws");
const t = setTimeout(() => { process.exit(1); }, 3000);
const w = new W("ws://localhost:18711/wsstream");
w.on("open", () => { w.send("hello over ws\n"); });
w.on("message", (d) => { console.log(d.toString()); w.close(); });
w.on("close", () => { clearTimeout(t); process.exit(0); });
w.on("error", (e) => { console.error("ws error:", e.message); clearTimeout(t); process.exit(1); });
```

```file:ws-disconnect-client.js
const W = require("ws");
const t = setTimeout(() => { process.exit(1); }, 3000);
const w = new W("ws://localhost:18711/wsstream");
w.on("open", () => { setTimeout(() => { w.close(); }, 300); });
w.on("close", () => { clearTimeout(t); process.exit(0); });
w.on("error", (e) => { console.error("ws error:", e.message); clearTimeout(t); process.exit(1); });
```

```afterAll
aux4 api stop 2>/dev/null
rm -rf .tmp
```

## WebSocket

### should have started server

```timeout
20000
```

```execute
npm install ws --no-save --no-audit --no-fund >/dev/null 2>&1
nohup aux4 api start --configFile config.yaml >/dev/null 2>&1 &
for i in $(seq 1 60); do curl -s -o /dev/null http://localhost:18711/ && break; sleep 0.25; done
curl -s -o /dev/null -w "%{http_code}" http://localhost:18711/
```

```expect
404
```

### should connect via websocket

```timeout
5000
```

```execute
node ws-client.js connect
```

```expect
connected
```

### should echo message via websocket

```timeout
5000
```

```execute
node ws-client.js echo
```

```expect:partial
hello ws
```

### should route to default action

```timeout
5000
```

```execute
node ws-client.js default
```

```expect:partial
fallback
```

## WebSocket stream session

### should echo frames sent by the client back as a stream of the command's stdout

```timeout
5000
```

```execute
node ws-stream-client.js
```

```expect:partial
hello over ws
```

### should kill the command process when the client disconnects

```timeout
8000
```

```execute
node ws-disconnect-client.js
sleep 2
pgrep -f "^aux4 apitest ws-echo-stdin" | wc -l | tr -d ' '
```

```expect
0
```
