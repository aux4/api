# api start websocket

```file:.aux4
{
  "profiles": [
    {
      "name": "main",
      "commands": [
        {
          "name": "ws-echo",
          "execute": ["stdin:node ws-echo.js"],
          "help": { "text": "WS echo" }
        }
      ]
    }
  ]
}
```

```file:ws-echo.js
const event = JSON.parse(require("fs").readFileSync(0, "utf8"));
const body = event.body ? JSON.parse(event.body) : {};
const response = { statusCode: 200, body: JSON.stringify({ echo: body.message || "no message", route: event.requestContext.routeKey }) };
console.log(JSON.stringify(response));
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
kill $(cat .pid-ws) 2>/dev/null
rm -f .pid-ws start-ws.sh
```

## WebSocket

### should have started server

```execute
SERVER_JS="$(cd .. && pwd)/lib/server.js"
WS_ARG='{"/ws":{"routes":{"$default":"ws-echo","echo":"ws-echo"}}}'
cat > start-ws.sh << SCRIPT
#!/bin/sh
node "$SERVER_JS" start 18711 '' '' '$WS_ARG' &
echo \$! > .pid-ws
SCRIPT
chmod +x start-ws.sh
./start-ws.sh </dev/null >/dev/null 2>&1
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
