# api start

```beforeAll
SERVER_JS="$(cd .. && pwd)/lib/server.js"
TEST_DIR=$(mktemp -d)
echo "$TEST_DIR" > .test-dir

mkdir -p "$TEST_DIR/views/layouts" "$TEST_DIR/views/users" "$TEST_DIR/static"

cat > "$TEST_DIR/say.js" << 'HANDLER'
const event = JSON.parse(require("fs").readFileSync(0, "utf8"));
const name = (event.queryStringParameters && event.queryStringParameters.name) || "World";
const response = { statusCode: 200, headers: { "Content-Type": "text/plain" }, body: "hello " + name };
console.log(JSON.stringify(response));
HANDLER

cat > "$TEST_DIR/update-user.js" << 'HANDLER'
const event = JSON.parse(require("fs").readFileSync(0, "utf8"));
const id = event.pathParameters && event.pathParameters.id;
const body = event.body ? JSON.parse(event.body) : {};
const response = { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id, name: body.name || "unknown" }) };
console.log(JSON.stringify(response));
HANDLER

cat > "$TEST_DIR/.aux4" << 'AUX4'
{
  "profiles": [
    {
      "name": "main",
      "commands": [
        {
          "name": "say",
          "execute": ["stdin:node say.js"],
          "help": { "text": "Say hello" }
        },
        {
          "name": "update-user",
          "execute": ["stdin:node update-user.js"],
          "help": { "text": "Update a user" }
        }
      ]
    }
  ]
}
AUX4

echo '<html><body>{{{body}}}</body></html>' > "$TEST_DIR/views/layouts/main.hbs"
echo '<h1>Hello Page</h1>' > "$TEST_DIR/views/hello.hbs"
echo '<p>User {{id}}</p>' > "$TEST_DIR/views/users/{id}.hbs"
echo '<div>Error {{statusCode}}: {{message}}</div>' > "$TEST_DIR/views/error.p.hbs"
echo 'aux4-logo' > "$TEST_DIR/static/logo.txt"

API_JSON='{"GET /say":{"command":"say"},"POST /users/{id}":{"command":"update-user"}}'
cat > "$TEST_DIR/start.sh" << SCRIPT
#!/bin/sh
cd "$TEST_DIR"
node "$SERVER_JS" start 18710 '' '$API_JSON' &
echo \$! > "$TEST_DIR/.pid"
SCRIPT
chmod +x "$TEST_DIR/start.sh"
"$TEST_DIR/start.sh" </dev/null >/dev/null 2>&1
sleep 1
```

```afterAll
TEST_DIR=$(cat .test-dir)
kill $(cat "$TEST_DIR/.pid") 2>/dev/null
rm -rf "$TEST_DIR" .test-dir
```

## REST API

### should respond with hello and query parameter

```execute
curl -s http://localhost:18710/api/say?name=Joe
```

```expect
hello Joe
```

### should respond with default name when no query parameter

```execute
curl -s http://localhost:18710/api/say
```

```expect
hello World
```

### should handle POST with path parameters

```execute
curl -s -X POST http://localhost:18710/api/users/42 -H "Content-Type: application/json" -d '{"name":"Alice"}'
```

```expect
{"id":"42","name":"Alice"}
```

### should return 404 for unknown API routes

```execute
curl -s -o /dev/null -w "%{http_code}" http://localhost:18710/api/unknown
```

```expect
404
```

## Views

### should render a Handlebars template with layout

```execute
curl -s http://localhost:18710/hello
```

```expect:partial
<h1>Hello Page</h1>
```

### should render dynamic path parameter in view

```execute
curl -s http://localhost:18710/users/99
```

```expect:partial
<p>User 99</p>
```

## Static files

### should serve a static file

```execute
curl -s http://localhost:18710/static/logo.txt
```

```expect
aux4-logo
```

## Error handling

### should render error template for 404

```execute
curl -s http://localhost:18710/nonexistent
```

```expect:partial
Error 404
```
