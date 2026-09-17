# aux4/api 2.1.3

Generic hardening against oversized command spawns (SFA-163).

## Fixed

- **`executeFile` could crash the runtime with a raw `spawn E2BIG`** — the structured
  execution path (`Command.executeFile`, used by Step Functions tasks invoking their own
  Cloud VM) built `execFile` argv directly from request params. When a single argument or
  the combined argv+env block exceeded the Linux execve limits, `execFile` failed with an
  uncaught `E2BIG` that escaped the Lambda as an opaque `{"errorMessage":"spawn E2BIG"}`
  with no actionable context. `executeFile` now measures the argv+env size before
  spawning and rejects an oversized command early with a clear message — *"Command is too
  large to spawn … Pass large parameters via a file or stdin, not argv."* — and wraps the
  synchronous `execFile` call in a `try/catch` so any synchronous spawn failure resolves
  as a clean non-zero result instead of throwing. Limits: `MAX_ARG_STRLEN` 128 KiB per
  argument, `MAX_ARGV_ENV_BYTES` 1 MiB total.

# aux4/api 2.1.2

Closes a silent-degradation gap in `type: oauth` session authentication.

## Fixed

- **Legacy session silently ran route commands without a delegated token** — a session
  cookie minted before the sealed AES-GCM envelope format (2.1.x) authenticates through
  the legacy identity-only JWT fallback, which carries no `__oauth` credentials. The
  request still succeeded (principal resolved, no 401), but no `AUX4_ACCESS_TOKEN` was
  injected, so route commands that delegate the signed-in user's token failed deep inside
  a subprocess with no signal in the browser, the network tab, or logs. The session auth
  path now treats "authenticated but no delegated token available" as a re-auth condition
  and returns `401 Authentication required`, giving the user a clean sign-in-again
  outcome instead of an opaque failure.

## Added

- **`security.auth.session.requireDelegation`** — defaults to `true` for `type: oauth`
  (delegation is the purpose of an oauth session). Set it to `false` for an oauth app
  whose routes genuinely need no delegated user token; a legacy identity-only session is
  then accepted as before.

# aux4/api 2.1.1

Combines the OAuth-session user-token injection lineage (route-backed commands
receive the signed-in user's access token via `AUX4_ACCESS_TOKEN`) with the
warm-container state-sync barrier for `api lambda-loop`. This restores the token
plumbing that was missing from 2.1.0 while keeping the stale-state fix.

## Fixed

- **Warm api-type Lambda served stale state** — `api lambda-loop` pulled cloud state
  only at cold start and pushed after a write, but never re-pulled before the next
  request. Warm sibling containers each held their own filesystem copy of the app's
  local state (e.g. a per-app conversation store), so a turn saved by one container was
  invisible to another and messages were lost. The loop now runs a
  **pull-before / push-after** barrier for stateful app actions, at parity with the
  command-type runtime.

## Added

- **State-sync barrier for `api lambda-loop`** — before handling a stateful app action
  (a route whose normalized path contains the `/action/` segment) the loop pulls fresh
  state; after the response is posted it pushes state. Both are best-effort and off the
  response path, so a failed sync never aborts a request. Static assets, the SPA shell,
  `/api/me`, and health checks are not gated, keeping page latency unchanged. Structured
  execution events keep using their own in-process pre/post sync hooks.
  - **`AUX4_LAMBDA_PRE_INVOKE_MODULE`** / **`AUX4_LAMBDA_POST_INVOKE_MODULE`** — in-process
    ES modules exporting `pullFromEnv(env)` / `pushFromEnv(env)` (cloud-file-sync's
    `sync-engine.mjs`), avoiding a per-call node subprocess.
  - **`AUX4_LAMBDA_PRE_INVOKE`** / **`AUX4_LAMBDA_POST_INVOKE`** — shell-command fallbacks
    used when the module can't be imported or the in-process call fails.
  - **`AUX4_LAMBDA_PRE_INVOKE_TTL_MS`** — coalesces back-to-back action pulls (default
    `2000`ms; `0` = pull before every action).
  - **`AUX4_LAMBDA_MAX_INVOCATIONS`** — exit the loop after N handled invocations instead
    of running forever (default unset); supports a bounded drain and test harnesses.

# aux4/api 2.0.34

## Added

- Trusted `handler` configuration for latency-sensitive REST routes and
  bearer/cookie authentication validators. Package-relative modules are
  identity-checked, cached across warm requests, retired on configuration
  changes, bounded by the existing concurrency/timeout controls, and return the
  same command-result envelope so proxy and stdout behavior stays compatible.

## Security

- Executable modules can be selected only by deployment configuration. Absolute
  paths, package identity mismatches, directory traversal, and symlink escapes
  are rejected before import. Timed-out handlers retain their concurrency slot
  until they actually settle.

# aux4/api 2.0.33

## Added

- Lambda entrypoints now dispatch API Gateway WebSocket v2 `$connect`,
  `$disconnect`, `$default`, and custom route events directly to `config.ws`
  commands. Message output can be delivered through the signed API Gateway
  Management API or returned for a configured route response.
- WebSocket `$connect` accepts API Gateway authorizer context or the existing
  aux4 application authentication configuration, forwarding the validated
  principal and request-local access token to the command.

## Changed

- Lambda transport handlers initialize lazily. WebSocket and structured
  execution events no longer boot Fastify, while REST events keep the existing
  cached full-app adapter.

# aux4/api 2.0.32

## Changed

- Structured Cloud execution phases can call the existing cloud-file-sync
  `pullFromEnv` and `pushFromEnv` entry points in-process. Cloud images opt in
  with `AUX4_LAMBDA_EXECUTION_SYNC_MODULE`; other installations retain the
  command-hook fallback.

# aux4/api 2.0.31

## Changed

- Auth and route commands may emit strict, trace-matched broker timing records on
  stderr. The API relays only the bounded timing schema, leaving ordinary stderr,
  credentials, request data, and command output private.

# aux4/api 2.0.30

## Fixed

- Execution grants are cached only when both credential and execution expiry
  timestamps are valid, with a 60-second safety margin before the earliest bound.

# aux4/api 2.0.29

## Fixed

- Trace correlation overrides now require a string, rejecting arrays or other
  values that can coerce to a valid identifier.

# aux4/api 2.0.28

## Changed

- Warm structured execution phases reuse bounded, expiry-aware execution grants,
  validate each command prefix, and evict grants on final results. Read-only
  grant exchanges retry once on authentication rejection; commands never replay.
- Structured execution logs include correlated JSON timing spans for grant
  retrieval, command validation/execution, checkpoint synchronization, completion,
  and total phase duration. Matching child timing spans are forwarded without
  exposing credentials or changing command output.

# aux4/api 2.0.27

## Fixed

- Structured Cloud executions now support synchronous pre/post invocation hooks.
  Stateful agent phases can refresh their session checkpoint before a command and
  durably upload it before Step Functions advances, even when consecutive phases
  run in different warm Lambda containers.

# aux4/api 2.0.26

## Changed

- OAuth web sessions are now opaque AES-256-GCM envelopes containing identity
  and provider token material. Access tokens refresh server-side near expiry and
  the rotated session is returned as an HttpOnly cookie.
- Authenticated route commands receive the validated user access token through
  request-local `AUX4_ACCESS_TOKEN`. The principal remains identity-only, and
  the warm command daemon preserves the per-invocation environment.
- Existing identity-only signed session cookies remain valid until their normal
  expiry.
- The warm Lambda runtime accepts structured `aux4.execution.v1` events from Step
  Functions. It exchanges an opaque execution id through the Cloud control plane
  and invokes a validated aux4 command array without a shell or token in workflow
  history.

# aux4/api 2.0.20

## Added

- **`security.auth.disableWhenEnv`** — a deploy-time kill switch for endpoint
  auth. When set to the name of an environment variable (e.g.
  `disableWhenEnv: OAUTH_APP_PUBLIC`), auth is turned off wholesale whenever that
  env var is `"true"`: `enabled` reports `false`, protected routes skip the
  validate command, and a token-less caller is allowed with a `null` principal
  instead of receiving a 401. Unset or any non-`"true"` value leaves auth fully
  enforced. This lets one image ship as either a secured or a fully-open service
  (e.g. an OAuth broker) without editing `config.yaml`.
