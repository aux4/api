# api start sessions

```file:config.yaml
config:
  port: 18713
  server:
    timeout: 2000
  security:
    auth:
      type: bearer
      command: aux4 apitest validate-token
  sessions:
    "/echo":
      command: aux4 apitest echo-stdin
      idleTimeout: 2000
      maxDuration: 10000
    "/ticker":
      command: aux4 apitest ticker
      idleTimeout: 10000
      maxDuration: 10000
    "/idle":
      command: aux4 apitest idle-command
      idleTimeout: 500
      maxDuration: 10000
    "/capped":
      command: aux4 apitest echo-stdin
      idleTimeout: 10000
      maxDuration: 10000
      maxPerPrincipal: 2
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
          "name": "validate-token",
          "execute": [
            "echo '${headers}' | jq -rc '{sub: ((.authorization // \"\") | sub(\"^Bearer \"; \"\"))}'"
          ],
          "help": {
            "text": "Validate a bearer token and return its principal",
            "variables": [
              { "name": "cookies", "text": "Cookies JSON", "default": "{}" },
              { "name": "headers", "text": "Headers JSON", "default": "{}" }
            ]
          }
        },
        {
          "name": "echo-stdin",
          "execute": [
            "stdin:cat"
          ],
          "help": {
            "text": "Echo stdin bytes back to stdout as they arrive",
            "variables": [
              { "name": "query", "text": "Query JSON", "default": "" },
              { "name": "headers", "text": "Headers JSON", "default": "" },
              { "name": "principal", "text": "Principal JSON", "default": "" }
            ]
          }
        },
        {
          "name": "ticker",
          "execute": [
            "i=0; while [ $i -lt 100 ]; do echo \"tick $i\"; i=$((i+1)); sleep 0.2; done"
          ],
          "help": {
            "text": "Print a tick line every 200ms",
            "variables": [
              { "name": "query", "text": "Query JSON", "default": "" },
              { "name": "headers", "text": "Headers JSON", "default": "" },
              { "name": "principal", "text": "Principal JSON", "default": "" }
            ]
          }
        },
        {
          "name": "idle-command",
          "execute": [
            "sleep 10"
          ],
          "help": {
            "text": "Produces no output at all, to exercise idle timeout",
            "variables": [
              { "name": "query", "text": "Query JSON", "default": "" },
              { "name": "headers", "text": "Headers JSON", "default": "" },
              { "name": "principal", "text": "Principal JSON", "default": "" }
            ]
          }
        }
      ]
    }
  ]
}
```

```afterAll
aux4 api stop 2>/dev/null
```

## session lifecycle

### should have started server

```timeout
20000
```

```execute
nohup aux4 api start --configFile config.yaml >/dev/null 2>&1 &
for i in $(seq 1 60); do curl -s -o /dev/null http://localhost:18713/ && break; sleep 0.25; done
curl -s -o /dev/null -w "%{http_code}" http://localhost:18713/
```

```expect
404
```

### should create a session, accept posted input, and end the stream on EOF

```timeout
5000
```

```execute
ID=$(curl -s -X POST -H "Authorization: Bearer user-a" http://localhost:18713/api/echo | jq -r '.id')
curl -s -X POST -H "Authorization: Bearer user-a" -H "Content-Type: application/octet-stream" --data-binary "hello session" http://localhost:18713/api/echo/$ID/input >/dev/null
curl -s -X POST -H "Authorization: Bearer user-a" http://localhost:18713/api/echo/$ID/end >/dev/null
curl -s -N -H "Authorization: Bearer user-a" http://localhost:18713/api/echo/$ID/events
```

```expect:partial
data: hello session
```

```expect:partial
event: end
```

### should forward raw input bytes unmodified regardless of the client's Content-Type

```timeout
5000
```

```execute
ID=$(curl -s -X POST -H "Authorization: Bearer user-a" http://localhost:18713/api/echo | jq -r '.id')
curl -s -X POST -H "Authorization: Bearer user-a" --data-binary "hello default content-type" http://localhost:18713/api/echo/$ID/input >/dev/null
curl -s -X POST -H "Authorization: Bearer user-a" http://localhost:18713/api/echo/$ID/end >/dev/null
curl -s -N -H "Authorization: Bearer user-a" http://localhost:18713/api/echo/$ID/events
```

```expect:partial
data: hello default content-type
```

```expect:partial
event: end
```

### should forward raw input bytes unmodified when Content-Type is application/json

```timeout
5000
```

```execute
ID=$(curl -s -X POST -H "Authorization: Bearer user-a" http://localhost:18713/api/echo | jq -r '.id')
curl -s -X POST -H "Authorization: Bearer user-a" -H "Content-Type: application/json" --data-binary '{"not":"parsed, raw bytes"}' http://localhost:18713/api/echo/$ID/input >/dev/null
curl -s -X POST -H "Authorization: Bearer user-a" http://localhost:18713/api/echo/$ID/end >/dev/null
curl -s -N -H "Authorization: Bearer user-a" http://localhost:18713/api/echo/$ID/events
```

```expect:partial
data: {"not":"parsed, raw bytes"}
```

```expect:partial
event: end
```

## unauthenticated

### should reject session create and events with 401 when no bearer token is presented

```timeout
5000
```

```execute
CREATE_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:18713/api/echo)
EVENTS_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:18713/api/echo/any-id/events)
echo "create=$CREATE_CODE events=$EVENTS_CODE"
```

```expect
create=401 events=401
```

## wrong principal

### should 404 when a different principal tries to read or feed another principal's session

```timeout
5000
```

```execute
ID=$(curl -s -X POST -H "Authorization: Bearer user-b" http://localhost:18713/api/echo | jq -r '.id')
EVENTS_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer user-c" http://localhost:18713/api/echo/$ID/events)
INPUT_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Authorization: Bearer user-c" -H "Content-Type: application/octet-stream" --data-binary "nope" http://localhost:18713/api/echo/$ID/input)
echo "events=$EVENTS_CODE input=$INPUT_CODE"
```

```expect
events=404 input=404
```

## session cap

### should allow sessions up to the cap and reject the next one for the same principal

```timeout
5000
```

```execute
TOKEN="cap-user"
A=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Authorization: Bearer $TOKEN" http://localhost:18713/api/capped)
B=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Authorization: Bearer $TOKEN" http://localhost:18713/api/capped)
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Authorization: Bearer $TOKEN" http://localhost:18713/api/capped)
echo "first=$A second=$B third=$C"
```

```expect
first=201 second=201 third=429
```

## idle timeout

### should end the stream early when the command is idle past idleTimeout

```timeout
5000
```

```execute
ID=$(curl -s -X POST -H "Authorization: Bearer idle-user" http://localhost:18713/api/idle | jq -r '.id')
curl -s -N -H "Authorization: Bearer idle-user" http://localhost:18713/api/idle/$ID/events
```

```expect:partial
event: end
```

## disconnect cleanup

### should kill the command process when the client disconnects

```timeout
8000
```

```execute
ID=$(curl -s -X POST -H "Authorization: Bearer disc-user" http://localhost:18713/api/ticker | jq -r '.id')
curl -s -N --max-time 1 -H "Authorization: Bearer disc-user" http://localhost:18713/api/ticker/$ID/events >/dev/null 2>&1
sleep 2
pgrep -f "^aux4 apitest ticker" | wc -l | tr -d ' '
```

```expect
0
```
