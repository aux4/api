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
