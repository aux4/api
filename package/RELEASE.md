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
