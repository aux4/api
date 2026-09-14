# api handle trusted in-process routes

```file:config.yaml
config:
  api:
    "POST /items/{id}":
      command: aux4 legacy fallback
      handler:
        package: aux4/api
        module: test/fixtures/in-process-handler.mjs
        factory: createHandler
        method: handle
        identity: installed-artifact-test
        options:
          marker: warm
```

```file:event.json
{
  "httpMethod": "POST",
  "path": "/items/item-7",
  "headers": {
    "content-type": "application/json",
    "x-aux4-trace-id": "abcdef0123456789abcdef0123456789"
  },
  "queryStringParameters": {
    "mode": "fast"
  },
  "body": "{\"message\":\"hello\"}",
  "isBase64Encoded": false,
  "requestContext": {
    "requestId": "request-7",
    "identity": {
      "sourceIp": "192.0.2.7"
    },
    "authorizer": {
      "sub": "user-7"
    }
  }
}
```

## installed route handler

### should execute the trusted package module and preserve proxy output

```execute
aux4 api handle --configFile config.yaml < event.json
```

```expect:json
{
  "statusCode": 201,
  "headers": {
    "x-handler": "warm",
    "content-type": "text/plain; charset=utf-8"
  },
  "body": "{\"method\":\"POST\",\"id\":\"item-7\",\"query\":\"fast\",\"principal\":{\"sub\":\"user-7\"},\"traceId\":\"abcdef0123456789abcdef0123456789\"}",
  "isBase64Encoded": false
}
```
