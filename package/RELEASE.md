# aux4/api 2.0.18

## Fixed

- **Warm Lambda runtime (`lambda-loop` / `lambda`) now loads routes from the config file.**
  The warm path built its app from the `config.api` command argument, but when routes are
  supplied via `--configFile` (aux4/config serializes the object as non-JSON), that argument
  is unusable and the app registered zero routes → every request 404'd. `buildHandler` now
  reads the app config from `--configFile` (`api`, `cors`, `server`, `components`, …) — the
  same source `api openapi` uses — so routes register correctly under the warm runtime.

## Added

- **Per-invocation config reload for the warm runtime.** `lambda-loop` re-checks the config
  file's mtime on each invocation and rebuilds the app **only when it changed** (a cheap
  `stat`; a no-op on the common unchanged path). A warm container picks up a hot-updated
  config without a redeploy, while the cold-start warm-reuse optimization is preserved.
