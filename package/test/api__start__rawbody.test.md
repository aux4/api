# api start raw body passthrough

Route commands must receive the byte-exact raw request body as `rawBody` on the event (and as
`--rawBody`), alongside the existing parsed `body`. This matters for signature verification (HMAC
webhook checks) that must be computed over exactly what the sender transmitted, not a re-serialized
`JSON.stringify` of the parsed body — which is not guaranteed byte-identical for escaped slashes,
unusual whitespace, or unicode escapes.

```file:.aux4
{
  "profiles": [
    {
      "name": "main",
      "commands": [
        {
          "name": "rawbodytest",
          "execute": [
            "profile:rawbodytest"
          ],
          "help": {
            "text": "rawBody test fixture commands"
          }
        }
      ]
    },
    {
      "name": "rawbodytest",
      "commands": [
        {
          "name": "echo",
          "execute": [
            "stdin:jq -rc '{statusCode: 200, headers: {\"Content-Type\": \"application/json\"}, body: ({body: .body, rawBody: .rawBody, same: (.body == .rawBody)} | tostring)}'"
          ],
          "help": {
            "text": "Echo both body and rawBody from stdin event"
          }
        },
        {
          "name": "echoflag",
          "execute": [
            "jq -n --arg rb '${rawBody}' '{statusCode: 200, headers: {\"Content-Type\": \"text/plain\"}, body: $rb}'"
          ],
          "help": {
            "text": "Echo the --rawBody CLI flag",
            "variables": [
              { "name": "rawBody", "text": "raw body flag", "default": "" }
            ]
          }
        }
      ]
    }
  ]
}
```

```file:config.yaml
config:
  port: 18732
  server:
    timeout: 2000
  api:
    "POST /echo":
      command: aux4 rawbodytest echo
    "POST /echoflag":
      command: aux4 rawbodytest echoflag
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
curl -s -o /dev/null -w "%{http_code}" http://localhost:18732/api/echo
```

```expect:partial
*?
```

## unusual whitespace and escaped slashes

### should deliver the exact raw bytes, not a re-serialized body

```execute
curl -s -X POST http://localhost:18732/api/echo -H "Content-Type: application/json" --data-binary '{"a":   1,   "url": "https:\/\/example.com\/x"}'
```

```expect:json
{
  "body": "{\"a\":1,\"url\":\"https://example.com/x\"}",
  "rawBody": "{\"a\":   1,   \"url\": \"https:\\/\\/example.com\\/x\"}",
  "same": false
}
```

## unicode payload

### should deliver unicode bytes unchanged in both body and rawBody

```execute
curl -s -X POST http://localhost:18732/api/echo -H "Content-Type: application/json" --data-binary '{"emoji":"😀","text":"café"}'
```

```expect:json
{
  "body": "{\"emoji\":\"😀\",\"text\":\"café\"}",
  "rawBody": "{\"emoji\":\"😀\",\"text\":\"café\"}",
  "same": true
}
```

## --rawBody CLI flag

### should also pass the raw body as a --rawBody flag to the command

```execute
curl -s -X POST http://localhost:18732/api/echoflag -H "Content-Type: application/json" --data-binary '{"a": 1, "note": "slash\/escape"}'
```

```expect
{"a": 1, "note": "slash\/escape"}
```
