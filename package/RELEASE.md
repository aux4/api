# aux4/api 2.0.16

## Features

### Warm aux4 command daemon, owned by the server

The api server now starts a warm aux4 daemon when it starts (`api start` and the
cloud `api lambda-loop` runtime) and stops it when it stops. Command-backed routes
— and any nested `aux4` calls their commands make — reuse the warm daemon instead
of cold-starting the aux4 CLI (~200ms) on every request. Best-effort: if the
daemon can't start, route commands transparently fall back to cold spawns.
Disable with `AUX4_API_NO_COMMAND_DAEMON`. (Requires aux4 core ≥ 5.2.6, which
fixes the daemon's nested-call re-entrancy.)

### `AUX4_COMMAND_DAEMON_DIR` — warm aux4 daemon for command-backed routes

Command-backed api routes shell out to `aux4 <command>` per request. When
`AUX4_COMMAND_DAEMON_DIR` points at a writable directory where a warm aux4 daemon
is listening, those child invocations are spawned from that directory with the
daemon enabled, so each `aux4 …` reuses the warm daemon instead of cold-starting
the CLI (~200ms) on every request. The api process itself is unaffected (it keeps
its own working directory so static files and views still resolve, and runs
daemonless). When the variable is unset, command execution is unchanged.



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
