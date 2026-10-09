# api start — body size vs argv embedding

`RestHandler.buildArgs` embeds request context (including the body) as flags in the shell command
string handed to the child process. That string is a single execve argv entry, capped on Linux by
`MAX_ARG_STRLEN` (128 KiB). A body over the embedding threshold (64 KiB) must NOT be embedded in
argv — but `CommandPool.execute` always pipes the full event (including the untruncated body) on
the child's stdin, so a `stdin:`-based command still receives it intact regardless of size. A body
well under the threshold must still arrive via the `--body` flag, unchanged from before.

```file:config.yaml
config:
  port: 18741
  server:
    timeout: 5000
  api:
    "POST /small":
      command: aux4 apitest smallbody
    "POST /large":
      command: aux4 apitest largebody
    "POST /large-stdin":
      command: aux4 apitest stdinbody
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
          "name": "smallbody",
          "execute": [
            "if(body==) && echo '{\"statusCode\":200,\"headers\":{\"Content-Type\":\"application/json\"},\"body\":\"ARGV_BODY_MISSING\"}' || echo '{\"statusCode\":200,\"headers\":{\"Content-Type\":\"application/json\"},\"body\":\"ARGV_BODY_PRESENT\"}'"
          ],
          "help": {
            "text": "Reports whether the --body argv flag was populated",
            "variables": [
              { "name": "body", "text": "Request body", "default": "" }
            ]
          }
        },
        {
          "name": "largebody",
          "execute": [
            "if(body==) && echo '{\"statusCode\":200,\"headers\":{\"Content-Type\":\"application/json\"},\"body\":\"ARGV_BODY_MISSING\"}' || echo '{\"statusCode\":200,\"headers\":{\"Content-Type\":\"application/json\"},\"body\":\"ARGV_BODY_PRESENT\"}'"
          ],
          "help": {
            "text": "Reports whether the --body argv flag was populated",
            "variables": [
              { "name": "body", "text": "Request body", "default": "" }
            ]
          }
        },
        {
          "name": "stdinbody",
          "execute": [
            "stdin:jq -rc '{statusCode: 200, headers: {\"Content-Type\": \"application/json\"}, body: (\"STDIN_BODY_LEN=\" + (.body | length | tostring))}'"
          ],
          "help": {
            "text": "Reports the length of the body seen on stdin (the full event, never size-limited)"
          }
        }
      ]
    }
  ]
}
```

```afterAll
aux4 api stop 2>/dev/null
rm -f body-600k.txt
```

## Server startup

### should have started the server

```execute
nohup aux4 api start --configFile config.yaml >/dev/null 2>&1 &
sleep 1
head -c 614400 /dev/zero | tr '\0' 'A' > body-600k.txt
curl -s -X POST http://localhost:18741/api/small -H "Content-Type: text/plain" -d "warmup"
```

```expect
ARGV_BODY_PRESENT
```

## small body (well under the 64 KiB embedding threshold)

### should still deliver the body via the --body argv flag

```execute
curl -s -X POST http://localhost:18741/api/small -H "Content-Type: text/plain" -d "hello-small"
```

```expect
ARGV_BODY_PRESENT
```

## 600 KB body (over the 64 KiB embedding threshold)

### should NOT embed the oversized body in the --body argv flag

```execute
curl -s -X POST http://localhost:18741/api/large -H "Content-Type: text/plain" --data-binary @body-600k.txt
```

```expect
ARGV_BODY_MISSING
```

### should still deliver the full 600 KB body intact on stdin to a stdin: command

```execute
curl -s -X POST http://localhost:18741/api/large-stdin -H "Content-Type: text/plain" --data-binary @body-600k.txt
```

```expect
STDIN_BODY_LEN=614400
```
