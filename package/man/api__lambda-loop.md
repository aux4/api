#### Description

The `lambda-loop` command is the **long-lived cloud runtime**: it builds the full Fastify application **once** and then owns the AWS Lambda **runtime API loop** itself, reusing the warm app across every invocation. This replaces the per-invocation model (`api lambda`, which serves one stdin event and exits) with a warm process that never rebuilds Fastify per call, and — being pure Node — sidesteps the aux4 daemon's nested-call deadlock. It is the entrypoint a container image runs; it reads events from the Lambda runtime API rather than from stdin.

Because a warm container reuses its filesystem across invocations, and several warm siblings each hold their own copy of the app's local state (e.g. a per-app SQLite conversation store managed by an external file-sync layer), the loop synchronizes state around each request so a warm sibling never serves stale data.

- **Pre-invoke pull (stateful actions only)** — before handling a request classified as a stateful app action, the loop pulls fresh state. The classification is purely the normalized route path — the greedy `{proxy+}` capture (falling back to `event.path` / `event.rawPath`, with a leading `/`) — containing the `/action/` segment. Static assets, the SPA shell, `/api/me`, and health checks are **not** gated, so page latency is unaffected. The pull prefers an in-process ES module (`AUX4_LAMBDA_PRE_INVOKE_MODULE` exporting `pullFromEnv(env)`) and falls back to the `AUX4_LAMBDA_PRE_INVOKE` shell command; it is coalesced by `AUX4_LAMBDA_PRE_INVOKE_TTL_MS` so back-to-back actions don't each pay a full round-trip.
- **Post-invoke push** — after the response is posted (off the response path), the loop pushes state so a write persists for the next container. It prefers the in-process `AUX4_LAMBDA_POST_INVOKE_MODULE` (`pushFromEnv(env)`) and falls back to the `AUX4_LAMBDA_POST_INVOKE` shell command.

Both sync steps are **best-effort**: a failed import, pull, or push is logged and **never** aborts the request.

Set **`AUX4_LAMBDA_STATE_SYNC_REQUIRED=true`** (or `1`/`yes`) only for quota-enrolled VMs to switch to a strict barrier. In strict mode both `AUX4_LAMBDA_PRE_INVOKE_MODULE` and `AUX4_LAMBDA_POST_INVOKE_MODULE` must import and export their respective functions. The pull runs before every ordinary HTTP handler and WebSocket dispatch, without TTL coalescing; a thrown or incomplete pull aborts the invocation and never runs the handler or pushes stale state. The push runs after dispatch (including a handler-produced HTTP error) and before the Runtime API response; a failed push posts an invocation error instead of success. Structured execution events retain their existing execution-specific barrier and are not double-pushed.

A `{ skipped: true }` hook result is accepted only when `CLOUD_STATE_ENABLED` is explicitly disabled (`false`, `0`, or `no`); an unconfigured/ambiguous skipped result fails closed.

##### Environment Variables

- **`AUX4_LAMBDA_PRE_INVOKE_MODULE`** — path to an ES module exporting `pullFromEnv(env)`; imported in-process and called before a stateful action.
- **`AUX4_LAMBDA_PRE_INVOKE`** — shell command run as a fallback when the pre-invoke module can't be imported or its pull fails.
- **`AUX4_LAMBDA_PRE_INVOKE_TTL_MS`** — coalescing window for the pre-invoke pull, in milliseconds (default `2000`; `0` = pull before every action).
- **`AUX4_LAMBDA_POST_INVOKE_MODULE`** — path to an ES module exporting `pushFromEnv(env)`; imported in-process and called after the response.
- **`AUX4_LAMBDA_POST_INVOKE`** — shell command run as a fallback when the post-invoke module can't be imported or its push fails.
- **`AUX4_LAMBDA_STATE_SYNC_REQUIRED`** — `true`/`1`/`yes` enables the fail-closed quota-enrolled VM barrier described above; unset/false preserves legacy best-effort behavior.
- **`AUX4_LAMBDA_MAX_INVOCATIONS`** — exit the loop after N handled invocations instead of running forever (default unset = run forever); useful for a bounded drain or a test harness.
- **`AWS_LAMBDA_RUNTIME_API`** — the runtime API host:port the loop polls for invocations (set by the Lambda runtime). Required; the command exits if it is unset.

#### Usage

```bash
aux4 api lambda-loop --configFile <config.yaml>
```

--configFile   Path to the config file whose `config.api` defines the routes (also populates `cors`, `ws`, `server`, `tls`, `security`, `production`, `components`)

The loop polls `AWS_LAMBDA_RUNTIME_API` for invocations and posts each response back to it; it does not read stdin or write responses to stdout.

#### Example

Container entrypoint (state sync wired by the image):

```bash
export AUX4_LAMBDA_PRE_INVOKE_MODULE="$HOME/.aux4.config/packages/aux4/cloud-file-sync/lib/sync-engine.mjs"
export AUX4_LAMBDA_POST_INVOKE_MODULE="$HOME/.aux4.config/packages/aux4/cloud-file-sync/lib/sync-engine.mjs"
export AUX4_LAMBDA_PRE_INVOKE_TTL_MS=2000

exec aux4 api lambda-loop --configFile /tmp/config.yaml
```

With this configuration a request to `GET /myapp/action/send-message` triggers a fresh-state pull before the handler runs (coalesced within 2s of a prior action pull), while a request to `GET /myapp/api/me` or a static asset is served directly with no pull.
