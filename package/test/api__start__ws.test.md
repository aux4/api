# api start websocket

```beforeAll
PKG_DIR="$(cd ../.. && pwd)"
SERVER_JS="$(cd .. && pwd)/lib/server.js"
TEST_DIR=$(mktemp -d)
echo "$TEST_DIR" > .test-dir-ws

cat > "$TEST_DIR/ws-echo.js" << 'HANDLER'
const event = JSON.parse(require("fs").readFileSync(0, "utf8"));
const body = event.body ? JSON.parse(event.body) : {};
const response = { statusCode: 200, body: JSON.stringify({ echo: body.message || "no message", route: event.requestContext.routeKey }) };
console.log(JSON.stringify(response));
HANDLER

cat > "$TEST_DIR/.aux4" << 'AUX4'
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
AUX4

cat > "$TEST_DIR/ws-client.js" << WSTEST
const W = require("$PKG_DIR/node_modules/ws");
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
WSTEST

WS_ARG='{"/ws":{"routes":{"$default":"ws-echo","echo":"ws-echo"}}}'
cat > "$TEST_DIR/start-ws.sh" << SCRIPT
#!/bin/sh
cd "$TEST_DIR"
node "$SERVER_JS" start 18711 '' '' '$WS_ARG' &
echo \$! > "$TEST_DIR/.pid-ws"
SCRIPT
chmod +x "$TEST_DIR/start-ws.sh"
"$TEST_DIR/start-ws.sh" </dev/null >/dev/null 2>&1
sleep 1
```

```afterAll
TEST_DIR=$(cat .test-dir-ws)
kill $(cat "$TEST_DIR/.pid-ws") 2>/dev/null
rm -rf "$TEST_DIR" .test-dir-ws
```

## WebSocket

### should have started server

```execute
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
TEST_DIR=$(cat .test-dir-ws) && node "$TEST_DIR/ws-client.js" connect
```

```expect
connected
```

### should echo message via websocket

```timeout
5000
```

```execute
TEST_DIR=$(cat .test-dir-ws) && node "$TEST_DIR/ws-client.js" echo
```

```expect:partial
hello ws
```

### should route to default action

```timeout
5000
```

```execute
TEST_DIR=$(cat .test-dir-ws) && node "$TEST_DIR/ws-client.js" default
```

```expect:partial
fallback
```
