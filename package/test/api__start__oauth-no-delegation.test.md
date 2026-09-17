# api start oauth no-delegation

Covers the `security.auth.session.requireDelegation: false` opt-out for `type: oauth`
sessions. By default an oauth session that carries no delegated user token (a legacy
identity-only cookie minted before the sealed-envelope format) is forced to re-auth,
because oauth sessions exist to delegate the user's `AUX4_ACCESS_TOKEN` to route
commands. An app whose routes genuinely need no delegated token opts out here: the same
legacy cookie then authenticates normally. This proves the default 401 comes from the
delegation gate rather than an invalid cookie, and that the escape hatch preserves
identity-only routes.

```file:mint-legacy-cookie.js
// Mint a pre-envelope legacy session cookie: a plain HS256 JWT signed with the
// session secret carrying identity claims but NO __oauth delegated-token envelope.
// This is exactly the cookie shape that authenticates through the legacy
// SessionToken.verify fallback and cannot supply AUX4_ACCESS_TOKEN.
const crypto = require("crypto");
const SECRET = "test-session-secret-value";

function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const now = Math.floor(Date.now() / 1000);
const header = { alg: "HS256", typ: "JWT" };
const claims = { sub: "user-42", email: "alice@example.com", name: "Alice", iat: now, exp: now + 3600 };
const signingInput = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(claims));
const signature = b64url(crypto.createHmac("sha256", SECRET).update(signingInput).digest());
process.stdout.write(signingInput + "." + signature);
```

```file:config.yaml
config:
  port: 18998
  server:
    timeout: 5000
  security:
    auth:
      type: oauth
      session:
        secret: test-session-secret-value
        cookie: auth_token
        ttl: 86400
        requireDelegation: false
      redirectAfterLogin: /welcome
      redirectOnError: /login
  api:
    "GET /me":
      command: aux4 whoami
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
        }
      ]
    }
  ]
}
```

```afterAll
aux4 api stop 2>/dev/null
true
```

## Setup

### should start the opt-out oauth server

```timeout
20000
```

```execute
nohup aux4 api start --configFile config.yaml >/dev/null 2>&1 &
for i in $(seq 1 60); do curl -s -o /dev/null "http://localhost:18998/api/me" && break; sleep 0.25; done
curl -s -o /dev/null -w "%{http_code}" "http://localhost:18998/api/me"
```

```expect:partial
401
```

## delegation disabled

### should still reject a request with no session cookie

```execute
curl -s -o /dev/null -w "%{http_code}" "http://localhost:18998/api/me"
```

```expect
401
```

### should authenticate a legacy identity-only cookie when delegation is disabled

```execute
LEGACY=$(node mint-legacy-cookie.js)
curl -s --cookie "auth_token=${LEGACY}" "http://localhost:18998/api/me"
```

```expect:partial
user=alice@example.com
```

### should reject a tampered cookie even when delegation is disabled

```execute
curl -s -o /dev/null -w "%{http_code}" --cookie "auth_token=not.a.validjwt" "http://localhost:18998/api/me"
```

```expect
401
```
