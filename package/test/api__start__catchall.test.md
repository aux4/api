# api start catch-all routing

```file:config.yaml
config:
  port: 18716
  server:
    timeout: 2000
  api:
    "GET /health":
      command: aux4 apitest health
    "* /svc/{rest...}":
      command: aux4 apitest catch
    "ANY /{path...}":
      command: aux4 apitest catch
```

```file:.aux4
{
  "profiles": [
    {
      "name": "main",
      "commands": [
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
          "name": "health",
          "execute": [
            "stdin:jq -rc '{statusCode: 200, headers: {\"Content-Type\": \"text/plain\"}, body: \"ok\"}'"
          ],
          "help": {
            "text": "Specific health route"
          }
        },
        {
          "name": "catch",
          "execute": [
            "stdin:jq -rc '{statusCode: 200, headers: {\"Content-Type\": \"application/json\"}, body: ({method: .httpMethod, params: .pathParameters, query: .queryStringParameters} | tostring)}'"
          ],
          "help": {
            "text": "Catch-all handler echoing method and captured path"
          }
        }
      ]
    }
  ]
}
```

```afterAll
aux4 api stop 2>/dev/null
rm -rf .tmp
```

## Server startup

### should have started the server

```execute
nohup aux4 api start --configFile config.yaml >/dev/null 2>&1 &
sleep 1
curl -s http://localhost:18716/api/health
```

```expect
ok
```

## Greedy catch-all path

### should capture a multi-segment path under the greedy param key

```execute
curl -s http://localhost:18716/api/a/b/c/d
```

```expect:json
{
  "method": "GET",
  "params": {
    "path": "a/b/c/d"
  },
  "query": null
}
```

### should capture a single-segment path

```execute
curl -s http://localhost:18716/api/hello
```

```expect:json
{
  "method": "GET",
  "params": {
    "path": "hello"
  },
  "query": null
}
```

### should still receive query parameters alongside the captured path

```execute
curl -s "http://localhost:18716/api/x/y?name=Joe"
```

```expect:json
{
  "method": "GET",
  "params": {
    "path": "x/y"
  },
  "query": {
    "name": "Joe"
  }
}
```

## ANY matches every method

### should match GET

```execute
curl -s -X GET http://localhost:18716/api/thing
```

```expect:json
{
  "method": "GET",
  "params": {
    "path": "thing"
  },
  "query": null
}
```

### should match POST

```execute
curl -s -X POST http://localhost:18716/api/thing
```

```expect:json
{
  "method": "POST",
  "params": {
    "path": "thing"
  },
  "query": null
}
```

### should match DELETE

```execute
curl -s -X DELETE http://localhost:18716/api/thing
```

```expect:json
{
  "method": "DELETE",
  "params": {
    "path": "thing"
  },
  "query": null
}
```

### should match PUT

```execute
curl -s -X PUT http://localhost:18716/api/thing
```

```expect:json
{
  "method": "PUT",
  "params": {
    "path": "thing"
  },
  "query": null
}
```

## Specific routes beat the catch-all

### should route GET /health to the specific command, not the catch-all

```execute
curl -s http://localhost:18716/api/health
```

```expect
ok
```

### should fall through to the catch-all for a method the specific route does not cover

```execute
curl -s -X POST http://localhost:18716/api/health
```

```expect:json
{
  "method": "POST",
  "params": {
    "path": "health"
  },
  "query": null
}
```

## The * method alias with a static prefix

### should match a prefixed greedy route via the * alias

```execute
curl -s -X PUT http://localhost:18716/api/svc/orders/42
```

```expect:json
{
  "method": "PUT",
  "params": {
    "rest": "orders/42"
  },
  "query": null
}
```

### should prefer the more-specific prefixed catch-all over the global catch-all

```execute
curl -s http://localhost:18716/api/svc/inventory
```

```expect:json
{
  "method": "GET",
  "params": {
    "rest": "inventory"
  },
  "query": null
}
```
