# aux4/api 2.1.0

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
  `/api/me`, and health checks are not gated, keeping page latency unchanged.
  - **`AUX4_LAMBDA_PRE_INVOKE_MODULE`** / **`AUX4_LAMBDA_POST_INVOKE_MODULE`** — in-process
    ES modules exporting `pullFromEnv(env)` / `pushFromEnv(env)` (cloud-file-sync's
    `sync-engine.mjs`), avoiding a per-call node subprocess.
  - **`AUX4_LAMBDA_PRE_INVOKE`** / **`AUX4_LAMBDA_POST_INVOKE`** — shell-command fallbacks
    used when the module can't be imported or the in-process call fails.
  - **`AUX4_LAMBDA_PRE_INVOKE_TTL_MS`** — coalesces back-to-back action pulls (default
    `2000`ms; `0` = pull before every action).
  - **`AUX4_LAMBDA_MAX_INVOCATIONS`** — exit the loop after N handled invocations instead
    of running forever (default unset); supports a bounded drain and test harnesses.

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
