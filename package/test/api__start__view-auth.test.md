# api start — view/404 auth gating

Covers the aux4/api PKG-API-014 fix: `security.auth` must also gate the convention-based
view routes (`ViewHandler`) and the 404 SPA-shell fallback, not just `/api/*`. Two servers
are used: one with no `security.auth` (public, unchanged behavior) and one with
`security.auth.type: oauth` (gated, real login redirect), driven through the real OAuth
dance against a mock OIDC provider.

```file:views/layouts/main.hbs
<html><body>{{{body}}}</body></html>
```

```file:views/index.hbs
<h1>Home</h1>
```

```file:views/apps/{id}.hbs
<p>App {{id}}</p>
```

```beforeAll
mkdir -p views/layouts views/apps
```

```afterAll
aux4 api stop 2>/dev/null
pkill -f mock-oidc-view-auth.js 2>/dev/null
rm -rf views .tmp
```

## Public (no security.auth)

```file:config-public.yaml
config:
  port: 18985
```

### should start the server with no security.auth

```execute
nohup aux4 api start --configFile config-public.yaml >/dev/null 2>&1 &
for i in $(seq 1 40); do curl -s -o /dev/null "http://localhost:18985/" && break; sleep 0.25; done
curl -s -o /dev/null -w "%{http_code}" "http://localhost:18985/"
```

```expect
200
```

### should serve a view route unauthenticated

```execute
curl -s "http://localhost:18985/apps/local"
```

```expect:partial
<p>App local</p>
```

### should serve the 404 SPA-shell fallback unauthenticated

```execute
curl -s -o /dev/null -w "%{http_code}" "http://localhost:18985/nowhere"
```

```expect
200
```

### should stop the public server

```execute
aux4 api stop
```

```expect:partial
*?
```

## Gated (security.auth: oauth)

```file:mock-oidc-view-auth.js
const http = require("http");
const url = require("url");

const PORT = 19985;

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
      res.end(JSON.stringify({ sub: "user-1", email: "bob@example.com" }));
    } else {
      res.writeHead(401);
      res.end("{}");
    }
    return;
  }

  res.writeHead(404);
  res.end("{}");
});

server.listen(PORT, () => console.log("mock-oidc-view-auth listening on " + PORT));
```

```file:config-oauth.yaml
config:
  port: 18986
  server:
    timeout: 5000
  security:
    auth:
      type: oauth
      session:
        secret: test-view-auth-session-secret
        cookie: auth_token
        ttl: 86400
      providers:
        mock:
          clientId: test-client
          clientSecret: s3cret
          redirectUri: http://localhost:18986/auth/callback
          authUrl: http://localhost:19985/authorize
          tokenUrl: http://localhost:19985/token
          userinfoUrl: http://localhost:19985/userinfo
          scopes: openid,email,profile
  api:
    "GET /me":
      command: aux4 echo-principal
```

```file:.aux4
{
  "profiles": [
    {
      "name": "main",
      "commands": [
        {
          "name": "echo-principal",
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
        }
      ]
    }
  ]
}
```

```timeout
20000
```

### should start the mock provider and the oauth-gated server

```execute
nohup node mock-oidc-view-auth.js >/dev/null 2>&1 &
nohup aux4 api start --configFile config-oauth.yaml >/dev/null 2>&1 &
for i in $(seq 1 60); do curl -s -o /dev/null "http://localhost:19985/authorize" && break; sleep 0.25; done
for i in $(seq 1 60); do curl -s -o /dev/null "http://localhost:18986/api/me" && break; sleep 0.25; done
curl -s -o /dev/null -w "%{http_code}" "http://localhost:18986/api/me"
```

```expect:partial
401
```

### should redirect an unauthenticated GET / to the signin route

```execute
curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "http://localhost:18986/"
```

```expect:partial
302 *?/auth/signin
```

### should redirect an unauthenticated view route to the signin route

```execute
curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "http://localhost:18986/apps/local"
```

```expect:partial
302 *?/auth/signin
```

### should redirect an unauthenticated unmatched route (404 fallback) to the signin route

```execute
curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "http://localhost:18986/nowhere"
```

```expect:partial
302 *?/auth/signin
```

### should keep /auth/signin itself reachable, not looped back to itself

```execute
curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "http://localhost:18986/auth/signin"
```

```expect:partial
302 http://localhost:19985/authorize**
```

### should keep /api/* returning JSON 401, not an HTML redirect

```execute
curl -s "http://localhost:18986/api/me"
```

```expect:json
{
  "message": "Unauthorized",
  "error": "Authentication required",
  "statusCode": 401
}
```

### should serve the home page once authenticated

```execute
rm -f cookies.txt
STATE=$(curl -s -c cookies.txt -o /dev/null -D - "http://localhost:18986/auth/signin" | grep -i "^location:" | sed -E 's/.*state=([^&]+).*/\1/' | tr -d "\r")
curl -s -b cookies.txt -c cookies.txt -o /dev/null "http://localhost:18986/auth/callback?code=good-code&state=${STATE}"
curl -s -b cookies.txt "http://localhost:18986/"
```

```expect:partial
<h1>Home</h1>
```

### should serve the 404 SPA-shell fallback once authenticated

```execute
curl -s -b cookies.txt -o /dev/null -w "%{http_code}" "http://localhost:18986/nowhere"
```

```expect
200
```

### should stop the gated server

```execute
aux4 api stop
```

```expect:partial
*?
```
