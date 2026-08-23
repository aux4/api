# aux4/api 2.0.17

## Features

### Warm aux4 command daemon for the cloud runtime

The cloud `api lambda-loop` runtime now starts a warm aux4 daemon and routes
command-backed requests through it, so each `aux4 <command>` — and any nested
`aux4` calls that command makes — reuses the warm CLI instead of cold-starting it
(~200ms) on every request. The win compounds for routes whose command fans out
into several `aux4` calls.

Design notes:
- The daemon is started **only** by the long-lived `lambda-loop` runtime (one
  request per container). The general `api start` server does **not** start it —
  the daemon serializes commands and can't stream, which would break concurrent
  requests and SSE.
- The socket lives at `AUX4_DAEMON_SOCKET` (a fixed writable path), so the daemon
  and its command clients agree on it **without changing any working directory**
  (route commands keep their CWD). Requires **aux4 core ≥ 5.2.7**.
- Streaming responses (SSE) always cold-spawn (they can't go through the daemon).
- Best-effort: if the daemon can't start, route commands fall back to cold spawns.
  Disable entirely with `AUX4_API_NO_COMMAND_DAEMON`.
