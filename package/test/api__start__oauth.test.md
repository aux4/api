# api start oauth

Drives the real OAuth web-login flow (`security.auth.type: oauth`) end-to-end through the
installed `aux4 oauth authorize-url` / `aux4 oauth exchange` commands against a mock OIDC
provider stood up in a `beforeAll` hook.

```file:mock-oidc.js
const http = require("http");
const url = require("url");

const PORT = 19911;

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);

  if (req.method === "POST" && u.pathname === "/token") {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      const params = new URLSearchParams(body);
      if (params.get("code") === "good-code") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: "mock-access-token", token_type: "Bearer" }));
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant" }));
      }
    });
    return;
  }

  if (req.method === "GET" && u.pathname === "/userinfo") {
    if ((req.headers.authorization || "") === "Bearer mock-access-token") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sub: "user-42", email: "alice@example.com", name: "Alice" }));
    } else {
      res.writeHead(401);
      res.end("{}");
    }
    return;
  }

  res.writeHead(404);
  res.end("{}");
});

server.listen(PORT, () => console.log("mock-oidc listening on " + PORT));
```

```file:config.yaml
config:
  port: 18999
  server:
    timeout: 5000
  security:
    auth:
      type: oauth
      session:
        secret: test-session-secret-value
        cookie: auth_token
        ttl: 86400
      redirectAfterLogin: /welcome
      redirectOnError: /login
      providers:
        mock:
          clientId: test-client
          clientSecret: s3cret
          redirectUri: http://localhost:18999/auth/callback
          authUrl: http://localhost:19911/authorize
          tokenUrl: http://localhost:19911/token
          userinfoUrl: http://localhost:19911/userinfo
          scopes: openid,email,profile
  api:
    "GET /me":
      command: aux4 whoami
    "GET /open":
      command: aux4 open-endpoint
      public: true
```

```file:.aux4
{
  "profiles": [
    {
      "name": "main",
      "commands": [
        {
          "name": "whoami",
          "execute": [
            "log:user=${principal.email}"
          ],
          "help": {
            "text": "Return the authenticated principal email",
            "variables": [
              {
                "name": "principal",
                "text": "Authenticated principal"
              }
            ]
          }
        },
        {
          "name": "open-endpoint",
          "execute": [
            "log:open-ok"
          ],
          "help": {
            "text": "Public endpoint"
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
pkill -f mock-oidc.js 2>/dev/null
true
```

## Setup

### should start the mock provider and the oauth-enabled server

```execute
nohup node mock-oidc.js >/dev/null 2>&1 &
nohup aux4 api start --configFile config.yaml >/dev/null 2>&1 &
sleep 2
curl -s -o /dev/null -w "%{http_code}" "http://localhost:18999/api/open"
```

```expect:partial
200
```

## signin

### should 302 to the provider authorize URL with PKCE challenge

```execute
curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "http://localhost:18999/auth/signin"
```

```expect:partial
302 http://localhost:19911/authorize?**code_challenge=**code_challenge_method=S256
```

### should set a short-lived signed state cookie

```execute
curl -s -D - -o /dev/null "http://localhost:18999/auth/signin" | grep -i "^set-cookie:" | grep -io "auth_oauth_state"
```

```expect
auth_oauth_state
```

## callback

### should set the session cookie and redirect after a valid code

```execute
rm -f cookies.txt
STATE=$(curl -s -c cookies.txt -o /dev/null -D - "http://localhost:18999/auth/signin" | grep -i "^location:" | sed -E 's/.*state=([^&]+).*/\1/' | tr -d "\r")
curl -s -b cookies.txt -c cookies.txt -o /dev/null -w "%{http_code} %{redirect_url}" "http://localhost:18999/auth/callback?code=good-code&state=${STATE}"
```

```expect:partial
302 *?/welcome
```

### should issue a session cookie that authorizes a protected route

```execute
rm -f cookies.txt
curl -s -c cookies.txt -o /dev/null "http://localhost:18999/auth/signin"
STATE=$(curl -s -c cookies.txt -o /dev/null -D - "http://localhost:18999/auth/signin" | grep -i "^location:" | sed -E 's/.*state=([^&]+).*/\1/' | tr -d "\r")
curl -s -b cookies.txt -c cookies.txt -o /dev/null "http://localhost:18999/auth/callback?code=good-code&state=${STATE}"
curl -s -b cookies.txt "http://localhost:18999/api/me"
```

```expect:partial
user=alice@example.com
```

## protected route auth

### should reject a request with no session cookie

```execute
curl -s -o /dev/null -w "%{http_code}" "http://localhost:18999/api/me"
```

```expect
401
```

### should reject a request with a tampered session cookie

```execute
curl -s -o /dev/null -w "%{http_code}" --cookie "auth_token=not.a.validjwt" "http://localhost:18999/api/me"
```

```expect
401
```

### should allow a public route without a session

```execute
curl -s "http://localhost:18999/api/open"
```

```expect:partial
open-ok
```

## logout

### should clear the session cookie

```execute
curl -s -D - -o /dev/null "http://localhost:18999/auth/logout" | grep -i "^set-cookie:" | grep -io "auth_token=;\|auth_token=;\?"
```

```expect:partial
auth_token=
```

### should redirect after logout

```execute
curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "http://localhost:18999/auth/logout"
```

```expect:partial
302 *?/login
```
