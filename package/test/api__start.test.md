# api start

```file:config.yaml
config:
  port: 18710
  api:
    "GET /say":
      command: aux4 say
    "POST /users/{id}":
      command: aux4 update-user
    "POST /upload":
      command: aux4 upload
```

```file:.aux4
{
  "profiles": [
    {
      "name": "main",
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
          "name": "upload",
          "execute": [
            "stdin:jq -rc '{statusCode: 200, headers: {\"Content-Type\": \"application/json\"}, body: ({files: [(.body | fromjson).document[].filename], category: ((.body | fromjson).category // \"none\")} | tostring)}'"
          ],
          "help": {
            "text": "Handle upload"
          }
        }
      ]
    }
  ]
}
```

```file:views/layouts/main.hbs
<html><body>{{{body}}}</body></html>
```

```file:views/hello.hbs
<h1>Hello Page</h1>
```

```file:views/users/{id}.hbs
<p>User {{id}}</p>
```

```file:views/error.p.hbs
<div>Error {{statusCode}}: {{message}}</div>
```

```file:static/logo.txt
aux4-logo
```

```beforeAll
mkdir -p views/layouts views/users static
```

```afterAll
aux4 api stop 2>/dev/null
rm -rf views static .tmp
```

## REST API

### should have started server

```execute
nohup aux4 api start --configFile config.yaml >/dev/null 2>&1 &
sleep 1
curl -s -o /dev/null -w "%{http_code}" http://localhost:18710/
```

```expect
404
```

### should respond with hello and query parameter

```execute
curl -s http://localhost:18710/api/say?name=Joe
```

```expect
hello Joe
```

### should respond with default name when no query parameter

```execute
curl -s http://localhost:18710/api/say
```

```expect
hello World
```

### should handle POST with path parameters

```execute
curl -s -X POST http://localhost:18710/api/users/42 -H "Content-Type: application/json" -d '{"name":"Alice"}'
```

```expect
{"id":"42","name":"Alice"}
```

### should return 404 for unknown API routes

```execute
curl -s -o /dev/null -w "%{http_code}" http://localhost:18710/api/unknown
```

```expect
404
```

## File upload

### should handle multipart file upload

```execute
echo "test content" > /tmp/test-upload.txt
curl -s -X POST http://localhost:18710/api/upload -F "document=@/tmp/test-upload.txt" -F "category=reports"
rm -f /tmp/test-upload.txt
```

```expect:partial
test-upload.txt
```

## Views

### should render a Handlebars template with layout

```execute
curl -s http://localhost:18710/hello
```

```expect:partial
<h1>Hello Page</h1>
```

### should render dynamic path parameter in view

```execute
curl -s http://localhost:18710/users/99
```

```expect:partial
<p>User 99</p>
```

## Static files

### should serve a static file

```execute
curl -s http://localhost:18710/static/logo.txt
```

```expect
aux4-logo
```

## Error handling

### should render error template for 404

```execute
curl -s http://localhost:18710/nonexistent
```

```expect:partial
Error 404
```
