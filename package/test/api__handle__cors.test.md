# api handle CORS

`api start` applies CORS through `@fastify/cors`. The Lambda/serverless path (`api handle`) never
runs Fastify, so it computes the same headers itself from `config.cors`. These tests cover the
handler path: the OPTIONS preflight short-circuit, actual-response echoing, the origin allowlist
(single and multiple members), `credentials`, `exposedHeaders`, `allowedHeaders`, `methods`, and
`maxAge` — asserting the exact proxy-response headers in every case.

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
            "text": "API handle CORS test fixture commands"
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
            "stdin:jq -rc '{statusCode: 200, headers: {\"Content-Type\": \"application/json\"}, body: ([{id: \"1\", name: \"Alice\"}] | tostring)}'"
          ],
          "help": {
            "text": "List contacts"
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

## with an allowed-origin allowlist

```file:config.yaml
config:
  cors:
    origin:
      - https://aux4.io
      - https://www.aux4.io
  server:
    timeout: 5000
  api:
    "GET /contacts":
      command: aux4 apitest list
    "POST /contacts":
      command: aux4 apitest create
```

### should answer an OPTIONS preflight with 204 and the CORS headers

```execute
echo '{"httpMethod":"OPTIONS","path":"/contacts","headers":{"origin":"https://aux4.io","access-control-request-method":"POST","access-control-request-headers":"content-type"},"body":null,"isBase64Encoded":false,"requestContext":{"requestId":"c1","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 204,
  "headers": {
    "access-control-allow-origin": "https://aux4.io",
    "vary": "Origin",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
    "access-control-allow-headers": "content-type"
  },
  "body": "",
  "isBase64Encoded": false
}
```

### should echo Access-Control-Allow-Origin on a cross-origin POST from an allowed origin

```execute
echo '{"httpMethod":"POST","path":"/contacts","headers":{"content-type":"application/json","origin":"https://aux4.io"},"body":"{\"name\":\"Carol\"}","isBase64Encoded":false,"requestContext":{"requestId":"c2","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 201,
  "headers": {
    "content-type": "application/json",
    "x-created": "yes",
    "access-control-allow-origin": "https://aux4.io",
    "vary": "Origin"
  },
  "body": "{\"created\":\"Carol\"}",
  "isBase64Encoded": false
}
```

### should NOT echo Access-Control-Allow-Origin for a disallowed origin

```execute
echo '{"httpMethod":"POST","path":"/contacts","headers":{"content-type":"application/json","origin":"https://evil.example"},"body":"{\"name\":\"Carol\"}","isBase64Encoded":false,"requestContext":{"requestId":"c3","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
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

## with a multi-origin allowlist (site-api case)

An allowlist with three distinct URLs must echo back whichever member sent the request — not just
the first entry. This is the site-api configuration where a production domain and two local dev
servers are all allowed.

```file:config.yaml
config:
  cors:
    origin:
      - https://aux4.io
      - http://localhost:4174
      - http://localhost:5173
  server:
    timeout: 5000
  api:
    "GET /contacts":
      command: aux4 apitest list
    "POST /contacts":
      command: aux4 apitest create
```

### should echo the first list member on an OPTIONS preflight

```execute
echo '{"httpMethod":"OPTIONS","path":"/contacts","headers":{"origin":"https://aux4.io","access-control-request-method":"POST","access-control-request-headers":"content-type"},"body":null,"isBase64Encoded":false,"requestContext":{"requestId":"m1","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 204,
  "headers": {
    "access-control-allow-origin": "https://aux4.io",
    "vary": "Origin",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
    "access-control-allow-headers": "content-type"
  },
  "body": "",
  "isBase64Encoded": false
}
```

### should echo the second list member on an OPTIONS preflight

```execute
echo '{"httpMethod":"OPTIONS","path":"/contacts","headers":{"origin":"http://localhost:4174","access-control-request-method":"POST","access-control-request-headers":"content-type"},"body":null,"isBase64Encoded":false,"requestContext":{"requestId":"m2","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 204,
  "headers": {
    "access-control-allow-origin": "http://localhost:4174",
    "vary": "Origin",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
    "access-control-allow-headers": "content-type"
  },
  "body": "",
  "isBase64Encoded": false
}
```

### should echo the third list member on an OPTIONS preflight

```execute
echo '{"httpMethod":"OPTIONS","path":"/contacts","headers":{"origin":"http://localhost:5173","access-control-request-method":"POST","access-control-request-headers":"content-type"},"body":null,"isBase64Encoded":false,"requestContext":{"requestId":"m3","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 204,
  "headers": {
    "access-control-allow-origin": "http://localhost:5173",
    "vary": "Origin",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
    "access-control-allow-headers": "content-type"
  },
  "body": "",
  "isBase64Encoded": false
}
```

### should echo the second member on an actual cross-origin POST

```execute
echo '{"httpMethod":"POST","path":"/contacts","headers":{"content-type":"application/json","origin":"http://localhost:4174"},"body":"{\"name\":\"Sally\"}","isBase64Encoded":false,"requestContext":{"requestId":"m4","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 201,
  "headers": {
    "content-type": "application/json",
    "x-created": "yes",
    "access-control-allow-origin": "http://localhost:4174",
    "vary": "Origin"
  },
  "body": "{\"created\":\"Sally\"}",
  "isBase64Encoded": false
}
```

### should echo the third member on an actual cross-origin POST

```execute
echo '{"httpMethod":"POST","path":"/contacts","headers":{"content-type":"application/json","origin":"http://localhost:5173"},"body":"{\"name\":\"Sally\"}","isBase64Encoded":false,"requestContext":{"requestId":"m5","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 201,
  "headers": {
    "content-type": "application/json",
    "x-created": "yes",
    "access-control-allow-origin": "http://localhost:5173",
    "vary": "Origin"
  },
  "body": "{\"created\":\"Sally\"}",
  "isBase64Encoded": false
}
```

### should NOT echo Access-Control-Allow-Origin for a non-member origin

```execute
echo '{"httpMethod":"POST","path":"/contacts","headers":{"content-type":"application/json","origin":"http://localhost:9999"},"body":"{\"name\":\"Sally\"}","isBase64Encoded":false,"requestContext":{"requestId":"m6","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 201,
  "headers": {
    "content-type": "application/json",
    "x-created": "yes"
  },
  "body": "{\"created\":\"Sally\"}",
  "isBase64Encoded": false
}
```

## with a wildcard origin

```file:config.yaml
config:
  cors:
    origin: "*"
  server:
    timeout: 5000
  api:
    "GET /contacts":
      command: aux4 apitest list
    "POST /contacts":
      command: aux4 apitest create
```

### should emit Access-Control-Allow-Origin star with no Vary on an actual response

```execute
echo '{"httpMethod":"POST","path":"/contacts","headers":{"content-type":"application/json","origin":"https://anything.example"},"body":"{\"name\":\"Carol\"}","isBase64Encoded":false,"requestContext":{"requestId":"w1","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 201,
  "headers": {
    "content-type": "application/json",
    "x-created": "yes",
    "access-control-allow-origin": "*"
  },
  "body": "{\"created\":\"Carol\"}",
  "isBase64Encoded": false
}
```

### should answer an OPTIONS preflight with a wildcard origin and no Vary

```execute
echo '{"httpMethod":"OPTIONS","path":"/contacts","headers":{"origin":"https://anything.example","access-control-request-method":"POST","access-control-request-headers":"content-type"},"body":null,"isBase64Encoded":false,"requestContext":{"requestId":"w2","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 204,
  "headers": {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
    "access-control-allow-headers": "content-type"
  },
  "body": "",
  "isBase64Encoded": false
}
```

## with origin reflection (origin true)

```file:config.yaml
config:
  cors:
    origin: true
  server:
    timeout: 5000
  api:
    "POST /contacts":
      command: aux4 apitest create
```

### should reflect the request Origin and add Vary on an actual response

```execute
echo '{"httpMethod":"POST","path":"/contacts","headers":{"content-type":"application/json","origin":"https://reflected.example"},"body":"{\"name\":\"Carol\"}","isBase64Encoded":false,"requestContext":{"requestId":"r1","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 201,
  "headers": {
    "content-type": "application/json",
    "x-created": "yes",
    "access-control-allow-origin": "https://reflected.example",
    "vary": "Origin"
  },
  "body": "{\"created\":\"Carol\"}",
  "isBase64Encoded": false
}
```

## with credentials and an allowlisted origin

```file:config.yaml
config:
  cors:
    origin:
      - https://aux4.io
    credentials: true
  server:
    timeout: 5000
  api:
    "POST /contacts":
      command: aux4 apitest create
```

### should send Allow-Credentials true with the reflected allowlisted origin

```execute
echo '{"httpMethod":"POST","path":"/contacts","headers":{"content-type":"application/json","origin":"https://aux4.io"},"body":"{\"name\":\"Carol\"}","isBase64Encoded":false,"requestContext":{"requestId":"cr1","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 201,
  "headers": {
    "content-type": "application/json",
    "x-created": "yes",
    "access-control-allow-origin": "https://aux4.io",
    "vary": "Origin",
    "access-control-allow-credentials": "true"
  },
  "body": "{\"created\":\"Carol\"}",
  "isBase64Encoded": false
}
```

## with credentials and a wildcard origin

The Fetch spec forbids `Access-Control-Allow-Credentials: true` together with a wildcard
`Access-Control-Allow-Origin: *`. When `credentials` is enabled and `origin` resolves to `*`, the
handler reflects the request Origin (with `Vary: Origin`) instead of emitting `*`.

```file:config.yaml
config:
  cors:
    origin: "*"
    credentials: true
  server:
    timeout: 5000
  api:
    "POST /contacts":
      command: aux4 apitest create
```

### should reflect the request Origin instead of star when credentials are enabled

```execute
echo '{"httpMethod":"POST","path":"/contacts","headers":{"content-type":"application/json","origin":"https://app.example"},"body":"{\"name\":\"Carol\"}","isBase64Encoded":false,"requestContext":{"requestId":"cw1","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 201,
  "headers": {
    "content-type": "application/json",
    "x-created": "yes",
    "access-control-allow-origin": "https://app.example",
    "vary": "Origin",
    "access-control-allow-credentials": "true"
  },
  "body": "{\"created\":\"Carol\"}",
  "isBase64Encoded": false
}
```

### should reflect the request Origin on the OPTIONS preflight when credentials are enabled

```execute
echo '{"httpMethod":"OPTIONS","path":"/contacts","headers":{"origin":"https://app.example","access-control-request-method":"POST","access-control-request-headers":"content-type"},"body":null,"isBase64Encoded":false,"requestContext":{"requestId":"cw2","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 204,
  "headers": {
    "access-control-allow-origin": "https://app.example",
    "vary": "Origin",
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
    "access-control-allow-headers": "content-type"
  },
  "body": "",
  "isBase64Encoded": false
}
```

## with a maxAge

`maxAge` belongs to the preflight only. It appears as `Access-Control-Max-Age` on the OPTIONS
response and is absent on actual responses.

```file:config.yaml
config:
  cors:
    origin: "*"
    maxAge: 600
  server:
    timeout: 5000
  api:
    "GET /contacts":
      command: aux4 apitest list
    "POST /contacts":
      command: aux4 apitest create
```

### should include Access-Control-Max-Age on the OPTIONS preflight

```execute
echo '{"httpMethod":"OPTIONS","path":"/contacts","headers":{"origin":"https://app.example","access-control-request-method":"POST","access-control-request-headers":"content-type"},"body":null,"isBase64Encoded":false,"requestContext":{"requestId":"ma1","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 204,
  "headers": {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600"
  },
  "body": "",
  "isBase64Encoded": false
}
```

### should NOT include Access-Control-Max-Age on an actual response

```execute
echo '{"httpMethod":"GET","path":"/contacts","headers":{"accept":"application/json","origin":"https://app.example"},"body":null,"isBase64Encoded":false,"requestContext":{"requestId":"ma2","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 200,
  "headers": {
    "content-type": "application/json",
    "access-control-allow-origin": "*"
  },
  "body": "[{\"id\":\"1\",\"name\":\"Alice\"}]",
  "isBase64Encoded": false
}
```

## with exposedHeaders

`exposedHeaders` maps to `Access-Control-Expose-Headers` on the actual response so the browser
allows the page to read those response headers.

```file:config.yaml
config:
  cors:
    origin: "*"
    exposedHeaders:
      - X-Total-Count
      - X-Page
  server:
    timeout: 5000
  api:
    "GET /contacts":
      command: aux4 apitest list
```

### should include Access-Control-Expose-Headers on the actual response

```execute
echo '{"httpMethod":"GET","path":"/contacts","headers":{"accept":"application/json","origin":"https://app.example"},"body":null,"isBase64Encoded":false,"requestContext":{"requestId":"e1","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 200,
  "headers": {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "X-Total-Count,X-Page"
  },
  "body": "[{\"id\":\"1\",\"name\":\"Alice\"}]",
  "isBase64Encoded": false
}
```

## with configured allowedHeaders

When `allowedHeaders` is configured it is sent verbatim on the preflight, ignoring whatever the
browser asked for in `access-control-request-headers`.

```file:config.yaml
config:
  cors:
    origin: "*"
    allowedHeaders:
      - Content-Type
      - Authorization
  server:
    timeout: 5000
  api:
    "POST /contacts":
      command: aux4 apitest create
```

### should send the configured allowedHeaders and ignore the requested headers

```execute
echo '{"httpMethod":"OPTIONS","path":"/contacts","headers":{"origin":"https://app.example","access-control-request-method":"POST","access-control-request-headers":"x-custom-thing"},"body":null,"isBase64Encoded":false,"requestContext":{"requestId":"ah1","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 204,
  "headers": {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
    "access-control-allow-headers": "Content-Type,Authorization"
  },
  "body": "",
  "isBase64Encoded": false
}
```

## with reflected allowedHeaders

When `allowedHeaders` is not configured the preflight reflects the browser's
`access-control-request-headers` back in `Access-Control-Allow-Headers`.

```file:config.yaml
config:
  cors:
    origin: "*"
  server:
    timeout: 5000
  api:
    "POST /contacts":
      command: aux4 apitest create
```

### should reflect the requested headers back on the preflight

```execute
echo '{"httpMethod":"OPTIONS","path":"/contacts","headers":{"origin":"https://app.example","access-control-request-method":"POST","access-control-request-headers":"x-custom-thing, authorization"},"body":null,"isBase64Encoded":false,"requestContext":{"requestId":"rh1","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 204,
  "headers": {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
    "access-control-allow-headers": "x-custom-thing, authorization"
  },
  "body": "",
  "isBase64Encoded": false
}
```

## with a methods override

```file:config.yaml
config:
  cors:
    origin: "*"
    methods:
      - GET
      - POST
  server:
    timeout: 5000
  api:
    "GET /contacts":
      command: aux4 apitest list
    "POST /contacts":
      command: aux4 apitest create
```

### should send the configured methods on the preflight

```execute
echo '{"httpMethod":"OPTIONS","path":"/contacts","headers":{"origin":"https://app.example","access-control-request-method":"POST","access-control-request-headers":"content-type"},"body":null,"isBase64Encoded":false,"requestContext":{"requestId":"me1","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 204,
  "headers": {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST",
    "access-control-allow-headers": "content-type"
  },
  "body": "",
  "isBase64Encoded": false
}
```

### should NOT carry Allow-Methods, Allow-Headers, or Max-Age on an actual response

An actual (non-OPTIONS) cross-origin response carries `Access-Control-Allow-Origin` but never the
preflight-only headers, even when `methods` / `allowedHeaders` / `maxAge` are configured.

```file:config.yaml
config:
  cors:
    origin: "*"
    methods:
      - GET
      - POST
    allowedHeaders:
      - Content-Type
    maxAge: 600
  server:
    timeout: 5000
  api:
    "GET /contacts":
      command: aux4 apitest list
```

```execute
echo '{"httpMethod":"GET","path":"/contacts","headers":{"accept":"application/json","origin":"https://app.example"},"body":null,"isBase64Encoded":false,"requestContext":{"requestId":"me2","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 200,
  "headers": {
    "content-type": "application/json",
    "access-control-allow-origin": "*"
  },
  "body": "[{\"id\":\"1\",\"name\":\"Alice\"}]",
  "isBase64Encoded": false
}
```

## with no CORS config (regression guard)

```file:config.yaml
config:
  server:
    timeout: 5000
  api:
    "GET /contacts":
      command: aux4 apitest list
```

### should emit no CORS headers when config.cors is absent

```execute
echo '{"httpMethod":"GET","path":"/contacts","headers":{"accept":"application/json","origin":"https://aux4.io"},"body":null,"isBase64Encoded":false,"requestContext":{"requestId":"c4","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 200,
  "headers": {
    "content-type": "application/json"
  },
  "body": "[{\"id\":\"1\",\"name\":\"Alice\"}]",
  "isBase64Encoded": false
}
```

### should return an unmodified 404 for an OPTIONS request when config.cors is absent

```execute
echo '{"httpMethod":"OPTIONS","path":"/contacts","headers":{"origin":"https://aux4.io"},"body":null,"isBase64Encoded":false,"requestContext":{"requestId":"c5","identity":{"sourceIp":"1.2.3.4"}}}' | aux4 api handle --configFile config.yaml
```

```expect:json
{
  "statusCode": 404,
  "headers": {
    "content-type": "application/json; charset=utf-8"
  },
  "body": "{\"message\":\"Route OPTIONS /contacts not found\",\"error\":\"Not Found\",\"statusCode\":404}",
  "isBase64Encoded": false
}
```
</content>
</invoke>
