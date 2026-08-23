# aux4/api 2.0.15

## Features

### `lambda-loop` — warm, long-lived Lambda runtime for the cloud

New `api lambda-loop` mode: build the Fastify app **once** and own the AWS Lambda
runtime API loop, reusing the warm app across every invocation. The previous
cloud path spawned a fresh `api lambda` per invocation, rebuilding Fastify each
call (~1s); with `lambda-loop` the build cost is paid once per cold start and
warm invocations drop to a few milliseconds. It runs entirely in Node (no aux4
daemon), and an optional `AUX4_LAMBDA_POST_INVOKE` shell hook runs **after** the
response is posted so stateful runtimes can sync state without adding latency.

```bash
# cloud runtime entrypoint (persistent process owning the runtime loop)
AWS_LAMBDA_RUNTIME_API=… aux4 api lambda-loop --configFile /tmp/config.yaml
```

`api lambda` (one event from stdin, then exit) is unchanged for CLI/local use.

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
