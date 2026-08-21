# aux4/api 2.0.15

## Features

### `security.auth.requiredScope` — gate an oauth session by a scope claim

The oauth session auth now supports an optional `requiredScope`. When set, an
authenticated user must carry that value in their `scopes` claim (populated from
the SSO `userinfo`) or the request is rejected with **403 Forbidden** — an
"only users with access to this scope" gate on top of authentication.

```yaml
config:
  security:
    auth:
      type: oauth
      requiredScope: acme        # session user must have "acme" in scopes[]
      session: { secret: "…", cookie: auth_token }
      # …providers…
```

The 403 is deliberate (not 401): an authenticated-but-unentitled user must not be
redirected back into the login flow (which would loop). Unauthenticated requests
still return 401 and, in oauth mode, redirect to `/auth/signin`. When
`requiredScope` is unset, behavior is unchanged.
