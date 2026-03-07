# api start

```file:.aux4
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
```

```file:say.js
const event = JSON.parse(require("fs").readFileSync(0, "utf8"));
const name = (event.queryStringParameters && event.queryStringParameters.name) || "World";
const response = { statusCode: 200, headers: { "Content-Type": "text/plain" }, body: "hello " + name };
console.log(JSON.stringify(response));
```

```file:update-user.js
const event = JSON.parse(require("fs").readFileSync(0, "utf8"));
const id = event.pathParameters && event.pathParameters.id;
const body = event.body ? JSON.parse(event.body) : {};
const response = { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id, name: body.name || "unknown" }) };
console.log(JSON.stringify(response));
```

```file:views/layouts/main.hbs
<html><body>{{{body}}}</body></html>
```

```file:views/hello.hbs
<h1>Hello Page</h1>
```

```file:views/users/{id}.hbs
<p>User {{id}}</p>
```

```file:views/error.p.hbs
<div>Error {{statusCode}}: {{message}}</div>
```

```file:static/logo.txt
aux4-logo
```

```beforeAll
mkdir -p views/layouts views/users static
```

```afterAll
kill $(cat .pid) 2>/dev/null
rm -f .pid start.sh
rm -rf views static
```

## REST API

### should have started server

```execute
SERVER_JS="$(cd .. && pwd)/lib/server.js"
API_JSON='{"GET /say":{"command":"say"},"POST /users/{id}":{"command":"update-user"}}'
cat > start.sh << SCRIPT
#!/bin/sh
node "$SERVER_JS" start 18710 '' '$API_JSON' &
echo \$! > .pid
SCRIPT
chmod +x start.sh
./start.sh </dev/null >/dev/null 2>&1
sleep 1
curl -s -o /dev/null -w "%{http_code}" http://localhost:18710/
```

```expect
404
```

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
