# api lambda

Runs a single API Gateway proxy event from stdin through the **full Fastify app**
via `@fastify/aws-lambda`, emitting the proxy response to stdout. Unlike `api handle`
(routing only), the whole application runs — so static files and binary downloads work.
REST routes live under `/api/`, static assets under `/static/`.

```file:config.yaml
config:
  api:
    "GET /say":
      command: aux4 apitest say
    "POST /users/{id}":
      command: aux4 apitest update-user
    "GET /download":
      command: aux4 apitest download
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
          "name": "say",
          "execute": [
            "stdin:jq -rc '{statusCode: 200, headers: {\"Content-Type\": \"text/plain\"}, body: (\"hello \" + (.queryStringParameters.name // \"World\"))}'"
          ],
          "help": {
            "text": "Say hello"
          }
        },
        {
          "name": "update-user",
          "execute": [
            "stdin:jq -rc '{statusCode: 200, headers: {\"Content-Type\": \"application/json\"}, body: ({id: .pathParameters.id, name: ((.body | fromjson).name // \"unknown\")} | tostring)}'"
          ],
          "help": {
            "text": "Update a user"
          }
        },
        {
          "name": "download",
          "execute": [
            "log:data:application/octet-stream;filename=report.bin;base64,SGVsbG8gYmluYXJ5"
          ],
          "help": {
            "text": "Return a binary file download"
          }
        }
      ]
    }
  ]
}
```

```file:static/logo.txt
aux4-logo
```

## REST

### should route a GET with a query parameter

```execute
echo '{"httpMethod":"GET","path":"/api/say","headers":{},"queryStringParameters":{"name":"Joe"},"body":null,"isBase64Encoded":false,"requestContext":{"identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api lambda --configFile config.yaml
```

```expect:partial
hello Joe
```

### should default the query parameter when absent

```execute
echo '{"httpMethod":"GET","path":"/api/say","headers":{},"queryStringParameters":null,"body":null,"isBase64Encoded":false,"requestContext":{"identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api lambda --configFile config.yaml
```

```expect:partial
hello World
```

### should route a POST with a path parameter and body

```execute
echo '{"httpMethod":"POST","path":"/api/users/42","headers":{"content-type":"application/json"},"body":"{\"name\":\"Alice\"}","isBase64Encoded":false,"requestContext":{"identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api lambda --configFile config.yaml
```

```expect:partial
\"id\":\"42\",\"name\":\"Alice\"
```

### should return 404 for an unknown route

```execute
echo '{"httpMethod":"GET","path":"/api/nope","headers":{},"body":null,"isBase64Encoded":false,"requestContext":{"identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api lambda --configFile config.yaml
```

```expect:partial
"statusCode":404
```

### should route on the {proxy+} capture, ignoring a base path in event.path

When fronted by an API Gateway custom domain with a base-path mapping, `event.path`
still carries the base path (e.g. `/myapp/api/say`). Routing uses
`event.pathParameters.proxy` (the greedy capture, `api/say`) instead, so the base
path is ignored.

```execute
echo '{"httpMethod":"GET","path":"/myapp/api/say","pathParameters":{"proxy":"api/say"},"headers":{},"queryStringParameters":{"name":"Proxy"},"body":null,"isBase64Encoded":false,"requestContext":{"identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api lambda --configFile config.yaml
```

```expect:partial
hello Proxy
```

## Static files

### should serve a static file from /static

```execute
echo '{"httpMethod":"GET","path":"/static/logo.txt","headers":{},"body":null,"isBase64Encoded":false,"requestContext":{"identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api lambda --configFile config.yaml
```

```expect:partial
aux4-logo
```

## Binary download

### should base64-encode a binary download so it survives API Gateway

```execute
echo '{"httpMethod":"GET","path":"/api/download","headers":{},"body":null,"isBase64Encoded":false,"requestContext":{"identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api lambda --configFile config.yaml
```

```expect:partial
"isBase64Encoded":true
```

### should mark the download as an attachment

```execute
echo '{"httpMethod":"GET","path":"/api/download","headers":{},"body":null,"isBase64Encoded":false,"requestContext":{"identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api lambda --configFile config.yaml
```

```expect:partial
report.bin
```
