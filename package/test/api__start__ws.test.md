# api start websocket

```file:config.yaml
config:
  port: 18711
  ws:
    "/ws":
      routes:
        $default: aux4 ws-echo
        echo: aux4 ws-echo
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
        }
      ]
    }
  ]
}
```

```file:ws-client.js
const W = require("../../node_modules/ws");
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

```afterAll
aux4 api stop 2>/dev/null
rm -rf .tmp
```

## WebSocket

### should have started server

```execute
nohup aux4 api start --configFile config.yaml >/dev/null 2>&1 &
sleep 1
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
