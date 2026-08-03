# api start body parsing

The HTTP -> CLI bridge must accept and record a request body for ANY content-type — including
`multipart/related` (from `aux4 curl --upload`), a raw byte payload with no `Content-Type`, and an
empty-body POST with `Content-Type: application/json`. Fastify would otherwise reject these at the
content-type layer (415 / 400) before the mounted command ever runs. Registered content-types
(application/json, text/plain, x-www-form-urlencoded, multipart/form-data) must keep working exactly
as before.

```file:config.yaml
config:
  port: 18731
  server:
    timeout: 2000
  api:
    "POST /raw":
      command: aux4 apitest echoraw
    "POST /echo":
      command: aux4 apitest echojson
    "POST /json":
      command: aux4 apitest echojson
    "PATCH /json":
      command: aux4 apitest echojson
    "POST /form":
      command: aux4 apitest echoform
    "POST /text":
      command: aux4 apitest echoraw
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
          "name": "echoraw",
          "execute": [
            "stdin:jq -rc '{statusCode: 200, headers: {\"Content-Type\": \"text/plain\"}, body: (.body // \"NO_BODY\")}'"
          ],
          "help": {
            "text": "Echo the raw request body back as text/plain"
          }
        },
        {
          "name": "echojson",
          "execute": [
            "stdin:jq -rc '{statusCode: 200, headers: {\"Content-Type\": \"application/json\"}, body: ({method: .httpMethod, body: (.body // null), text: (.queryStringParameters.text // null)} | tostring)}'"
          ],
          "help": {
            "text": "Echo method, raw body and the text query param"
          }
        },
        {
          "name": "echoform",
          "execute": [
            "stdin:jq -rc '{statusCode: 200, headers: {\"Content-Type\": \"application/json\"}, body: ({name: ((.body | fromjson).name // \"unknown\"), age: ((.body | fromjson).age // \"unknown\")} | tostring)}'"
          ],
          "help": {
            "text": "Parse a form-urlencoded body (delivered as JSON) and echo fields"
          }
        }
      ]
    }
  ]
}
```

```file:multipart-related.txt
--BND
Content-Type: application/json

{"name":"doc.md","mimeType":"application/vnd.google-apps.document"}
--BND
Content-Type: text/markdown

# Hello World
--BND--
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
curl -s -X POST http://localhost:18731/api/text -H "Content-Type: text/plain" -d "ping"
```

```expect
ping
```

## multipart/related (unregistered content-type)

### should accept a multipart/related body instead of returning 415

```execute
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:18731/api/raw -H "Content-Type: multipart/related; boundary=BND" --data-binary @multipart-related.txt
```

```expect
200
```

### should deliver the raw multipart body to the command

```execute
curl -s -X POST http://localhost:18731/api/raw -H "Content-Type: multipart/related; boundary=BND" --data-binary @multipart-related.txt
```

```expect:partial
**"name":"doc.md"**Content-Type: text/markdown**# Hello World**
```

## request with no Content-Type header

### should accept a body with no Content-Type instead of returning 415

```execute
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:18731/api/raw -H "Content-Type:" --data-binary "raw-bytes-no-content-type"
```

```expect
200
```

### should deliver the raw body to the command

```execute
curl -s -X POST http://localhost:18731/api/raw -H "Content-Type:" --data-binary "raw-bytes-no-content-type"
```

```expect
raw-bytes-no-content-type
```

## empty application/json body

### should accept an empty JSON body instead of returning 400

```execute
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:18731/api/echo?text=lunch" -H "Content-Type: application/json"
```

```expect
200
```

### should record the request so the command sees the query with no body

```execute
curl -s -X POST "http://localhost:18731/api/echo?text=lunch" -H "Content-Type: application/json"
```

```expect:json
{
  "method": "POST",
  "body": null,
  "text": "lunch"
}
```

### should also accept an empty JSON body on PATCH

```execute
curl -s -o /dev/null -w "%{http_code}" -X PATCH "http://localhost:18731/api/json" -H "Content-Type: application/json"
```

```expect
200
```

## regression: valid application/json still parses

### should parse a non-empty JSON body exactly as before

```execute
curl -s -X POST "http://localhost:18731/api/json" -H "Content-Type: application/json" -d '{"name":"Alice","age":30}'
```

```expect:json
{
  "method": "POST",
  "body": "{\"name\":\"Alice\",\"age\":30}",
  "text": null
}
```

### should still reject a non-empty invalid JSON body with 400

```execute
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:18731/api/json" -H "Content-Type: application/json" -d '{not valid json'
```

```expect
400
```

## regression: form-urlencoded still parses

### should parse a form-urlencoded body into fields

```execute
curl -s -X POST http://localhost:18731/api/form -H "Content-Type: application/x-www-form-urlencoded" -d "name=Alice&age=30"
```

```expect:json
{
  "name": "Alice",
  "age": "30"
}
```

## regression: text/plain still flows through

### should deliver a text/plain body unchanged

```execute
curl -s -X POST http://localhost:18731/api/text -H "Content-Type: text/plain" -d "just some plain text"
```

```expect
just some plain text
```
