# api start root mount coexistence

Under ROOT MOUNT (`server.basePath: /`) RestHandler mounts a bare `/*` catch-all. Fastify's
router gives more-specific registered routes priority over that wildcard, so static files,
OAuth routes, WebSocket and the views `index.hbs` SPA 404-fallback are never swallowed. This
scenario stands up a server that has all of static, views and a declared route at once.

This lives in its own file because enabling views/static is filesystem-driven (the presence of
`./views` and `./static`), which would change behavior for the plain-prefix scenarios.

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

```file:static/file.txt
STATIC-OK
```

```file:views/layouts/main.hbs
{{{body}}}
```

```file:views/index.hbs
<html><body>SPA-INDEX</body></html>
```

```file:coex.yaml
config:
  port: 18834
  server:
    basePath: /
    timeout: 3000
  api:
    "GET /data":
      command: aux4 echo-path
```

```afterAll
aux4 api stop 2>/dev/null
rm -rf .pid coex.yaml static views
```

## root mount with static and views

### should serve the declared route

```execute
aux4 api stop 2>/dev/null
nohup aux4 api start --configFile coex.yaml >/dev/null 2>&1 &
for i in $(seq 1 40); do curl -s -o /dev/null http://localhost:18834/data && break; sleep 0.25; done
curl -s http://localhost:18834/data
```

```expect:json
{
  "path": "/data",
  "method": "GET",
  "params": null
}
```

### should not swallow the static file route

```execute
curl -s http://localhost:18834/static/file.txt
```

```expect
STATIC-OK
```

### should fall through to the views index.hbs SPA fallback for an unmatched GET

```execute
curl -s http://localhost:18834/somepage
```

```expect:partial
SPA-INDEX
```
