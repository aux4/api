# api start configurable mount prefix

Declared routes mount under `server.basePath` (default `/api`). A custom prefix serves
there and 404s elsewhere; `/` (or `""`) means ROOT MOUNT — routes served at bare paths.
Each scenario runs its own server on its own port; the opener stops any previous one
(the `.pid` file always points at the last-started server) so only one runs at a time.

```file:.aux4
{
  "profiles": [
    {
      "name": "main",
      "commands": [
        {
          "name": "echo-path",
          "execute": [
            "stdin:jq -rc '{statusCode:200, headers:{\"Content-Type\":\"application/json\"}, body:({path:.path, method:.httpMethod, params:.pathParameters}|tostring)}'"
          ],
          "help": {
            "text": "Echo the event path, method and captured params"
          }
        }
      ]
    }
  ]
}
```

```file:bp-default.yaml
config:
  port: 18831
  server:
    timeout: 3000
  api:
    "GET /hello":
      command: aux4 echo-path
```

```file:bp-v1.yaml
config:
  port: 18832
  server:
    basePath: /v1
    timeout: 3000
  api:
    "GET /hello":
      command: aux4 echo-path
```

```file:bp-root.yaml
config:
  port: 18833
  server:
    basePath: /
    timeout: 3000
  api:
    "ANY /{path...}":
      command: aux4 echo-path
```

```afterAll
aux4 api stop 2>/dev/null
rm -f .pid bp-default.yaml bp-v1.yaml bp-root.yaml
```

## default prefix

### should start the server on the default /api prefix

```execute
aux4 api stop 2>/dev/null
nohup aux4 api start --configFile bp-default.yaml >/dev/null 2>&1 &
for i in $(seq 1 40); do curl -s -o /dev/null http://localhost:18831/api/hello && break; sleep 0.25; done
curl -s http://localhost:18831/api/hello
```

```expect:json
{
  "path": "/hello",
  "method": "GET",
  "params": null
}
```

### should 404 at the bare path when no basePath is configured

```execute
curl -s -o /dev/null -w "%{http_code}" http://localhost:18831/hello
```

```expect
404
```

## custom prefix

### should start the server on the custom /v1 prefix

```execute
aux4 api stop 2>/dev/null
nohup aux4 api start --configFile bp-v1.yaml >/dev/null 2>&1 &
for i in $(seq 1 40); do curl -s -o /dev/null http://localhost:18832/v1/hello && break; sleep 0.25; done
curl -s http://localhost:18832/v1/hello
```

```expect:json
{
  "path": "/hello",
  "method": "GET",
  "params": null
}
```

### should 404 at the old /api prefix

```execute
curl -s -o /dev/null -w "%{http_code}" http://localhost:18832/api/hello
```

```expect
404
```

### should 404 at the bare path

```execute
curl -s -o /dev/null -w "%{http_code}" http://localhost:18832/hello
```

```expect
404
```

## root mount

### should start the server at root mount

```execute
aux4 api stop 2>/dev/null
nohup aux4 api start --configFile bp-root.yaml >/dev/null 2>&1 &
for i in $(seq 1 40); do curl -s -o /dev/null http://localhost:18833/anything && break; sleep 0.25; done
curl -s http://localhost:18833/anything
```

```expect:json
{
  "path": "/anything",
  "method": "GET",
  "params": {
    "path": "anything"
  }
}
```

### should serve a bare multi-segment path (PKG-120 repro)

```execute
curl -s http://localhost:18833/public/aux4/config/0.1.1
```

```expect:json
{
  "path": "/public/aux4/config/0.1.1",
  "method": "GET",
  "params": {
    "path": "public/aux4/config/0.1.1"
  }
}
```

### should serve the root path

```execute
curl -s http://localhost:18833/
```

```expect:json
{
  "path": "/",
  "method": "GET",
  "params": {
    "path": ""
  }
}
```
