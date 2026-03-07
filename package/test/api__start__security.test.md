# api start security

```file:config.yaml
config:
  port: 18712
  server:
    timeout: 2000
  security:
    apiKey: test-secret-key
    header: X-API-Key
    rateLimit:
      max: 100
      timeWindow: 60000
    helmet: true
    allowedIPs:
      - 127.0.0.1
  api:
    "GET /public":
      command: aux4 public-endpoint
      public: true
    "GET /private":
      command: aux4 private-endpoint
    "GET /admin":
      command: aux4 admin-endpoint
      allowedIPs:
        - 10.0.0.1
    "GET /limited":
      command: aux4 limited-endpoint
      rateLimit:
        max: 3
        timeWindow: 60000
```

```file:.aux4
{
  "profiles": [
    {
      "name": "main",
      "commands": [
        {
          "name": "public-endpoint",
          "execute": [
            "log:public-ok"
          ],
          "help": {
            "text": "Public endpoint"
          }
        },
        {
          "name": "private-endpoint",
          "execute": [
            "log:private-ok"
          ],
          "help": {
            "text": "Private endpoint"
          }
        },
        {
          "name": "admin-endpoint",
          "execute": [
            "log:admin-ok"
          ],
          "help": {
            "text": "Admin endpoint"
          }
        },
        {
          "name": "limited-endpoint",
          "execute": [
            "log:limited-ok"
          ],
          "help": {
            "text": "Rate limited endpoint"
          }
        }
      ]
    }
  ]
}
```

```beforeAll
true
```

```afterAll
aux4 api stop 2>/dev/null
```

## Setup

### should start server with security config

```execute
nohup aux4 api start --configFile config.yaml >/dev/null 2>&1 &
sleep 1
curl -s -o /dev/null -w "%{http_code}" -H "X-API-Key: test-secret-key" http://localhost:18712/api/private
```

```expect
200
```

## API Key

### should reject request without API key

```execute
curl -s -o /dev/null -w "%{http_code}" http://localhost:18712/api/private
```

```expect
401
```

### should reject request with wrong API key

```execute
curl -s -o /dev/null -w "%{http_code}" -H "X-API-Key: wrong-key" http://localhost:18712/api/private
```

```expect
401
```

### should accept request with valid API key

```execute
curl -s -H "X-API-Key: test-secret-key" http://localhost:18712/api/private
```

```expect
private-ok
```

### should allow public route without API key

```execute
curl -s http://localhost:18712/api/public
```

```expect
public-ok
```

## IP Allowlist

### should reject per-route allowedIPs that does not include localhost

```execute
curl -s -o /dev/null -w "%{http_code}" -H "X-API-Key: test-secret-key" http://localhost:18712/api/admin
```

```expect
403
```

## Rate Limit

### should include rate limit headers

```execute
curl -s -D - -o /dev/null -H "X-API-Key: test-secret-key" http://localhost:18712/api/private 2>/dev/null | grep -i "x-ratelimit-limit"  | head -1 | tr -d '\r' | awk -F': ' '{print $1}'
```

```expect:partial
x-ratelimit-limit
```

### should enforce per-route rate limit

```execute
for i in 1 2 3 4; do curl -s -o /dev/null -w "%{http_code}\n" -H "X-API-Key: test-secret-key" http://localhost:18712/api/limited; done | tail -1
```

```expect
429
```

## Helmet

### should include security headers from helmet

```execute
curl -s -D - -o /dev/null -H "X-API-Key: test-secret-key" http://localhost:18712/api/private 2>/dev/null | grep -i "x-content-type-options" | tr -d '\r' | tr '[:upper:]' '[:lower:]'
```

```expect:partial
nosniff
```
