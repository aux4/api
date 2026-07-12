# api handle

Runs a single API Gateway REST v1 proxy event from stdin through the routing engine and emits
the proxy response `{statusCode, headers, body, isBase64Encoded}` to stdout — the in-process,
one-event-per-invocation entrypoint used by the Lambda runtime (no HTTP server, no socket).

```file:config.yaml
config:
  server:
    timeout: 5000
  api:
    "GET /contacts":
      command: aux4 apitest list
    "GET /contacts/{id}":
      command: aux4 apitest get
    "GET /search":
      command: aux4 apitest search
    "POST /contacts":
      command: aux4 apitest create
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
            "text": "API handle test fixture commands"
          }
        }
      ]
    },
    {
      "name": "apitest",
      "commands": [
        {
          "name": "list",
          "execute": [
            "stdin:jq -rc '{statusCode: 200, headers: {\"Content-Type\": \"application/json\"}, body: ([{id: \"1\", name: \"Alice\"}, {id: \"2\", name: \"Bob\"}] | tostring)}'"
          ],
          "help": {
            "text": "List contacts"
          }
        },
        {
          "name": "get",
          "execute": [
            "stdin:jq -rc '{statusCode: 200, headers: {\"Content-Type\": \"application/json\"}, body: ({id: .pathParameters.id, found: true} | tostring)}'"
          ],
          "help": {
            "text": "Get a contact by id"
          }
        },
        {
          "name": "search",
          "execute": [
            "stdin:jq -rc '{statusCode: 200, headers: {\"Content-Type\": \"application/json\"}, body: ({query: .queryStringParameters.q} | tostring)}'"
          ],
          "help": {
            "text": "Search contacts"
          }
        },
        {
          "name": "create",
          "execute": [
            "stdin:jq -rc '{statusCode: 201, headers: {\"Content-Type\": \"application/json\", \"X-Created\": \"yes\"}, body: ({created: ((.body | fromjson).name)} | tostring)}'"
          ],
          "help": {
            "text": "Create a contact"
          }
        }
      ]
    }
  ]
}
```

## GET route

### should route GET /contacts and return the list

```execute
echo '{"httpMethod":"GET","path":"/contacts","headers":{"accept":"application/json"},"queryStringParameters":null,"body":null,"isBase64Encoded":false,"requestContext":{"requestId":"r1","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 200,
  "headers": {
    "content-type": "application/json"
  },
  "body": "[{\"id\":\"1\",\"name\":\"Alice\"},{\"id\":\"2\",\"name\":\"Bob\"}]",
  "isBase64Encoded": false
}
```

## path parameter

### should extract the {id} path parameter

```execute
echo '{"httpMethod":"GET","path":"/contacts/123","headers":{"accept":"application/json"},"body":null,"isBase64Encoded":false,"requestContext":{"requestId":"r2","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 200,
  "headers": {
    "content-type": "application/json"
  },
  "body": "{\"id\":\"123\",\"found\":true}",
  "isBase64Encoded": false
}
```

## query parameter

### should receive the q query parameter

```execute
echo '{"httpMethod":"GET","path":"/search","headers":{"accept":"application/json"},"queryStringParameters":{"q":"alice"},"body":null,"isBase64Encoded":false,"requestContext":{"requestId":"r3","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 200,
  "headers": {
    "content-type": "application/json"
  },
  "body": "{\"query\":\"alice\"}",
  "isBase64Encoded": false
}
```

## POST with JSON body

### should route POST /contacts and receive the body

```execute
echo '{"httpMethod":"POST","path":"/contacts","headers":{"content-type":"application/json"},"body":"{\"name\":\"Carol\"}","isBase64Encoded":false,"requestContext":{"requestId":"r4","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 201,
  "headers": {
    "content-type": "application/json",
    "x-created": "yes"
  },
  "body": "{\"created\":\"Carol\"}",
  "isBase64Encoded": false
}
```

## base64-encoded body

### should decode an isBase64Encoded request body before routing

```execute
echo '{"httpMethod":"POST","path":"/contacts","headers":{"content-type":"application/json"},"body":"eyJuYW1lIjoiRGF2ZSJ9","isBase64Encoded":true,"requestContext":{"requestId":"r5","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 201,
  "headers": {
    "content-type": "application/json",
    "x-created": "yes"
  },
  "body": "{\"created\":\"Dave\"}",
  "isBase64Encoded": false
}
```

## unknown route

### should return 404 for an unmapped route

```execute
echo '{"httpMethod":"GET","path":"/nope","headers":{},"body":null,"isBase64Encoded":false,"requestContext":{"requestId":"r6","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 404,
  "headers": {
    "content-type": "application/json; charset=utf-8"
  },
  "body": "{\"message\":\"Route GET /nope not found\",\"error\":\"Not Found\",\"statusCode\":404}",
  "isBase64Encoded": false
}
```
