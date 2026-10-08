# aux4/api 2.1.0

## Added

- **Session streaming** — a generic, command-agnostic way to run a long-lived
  command and stream to/from it over HTTP or WebSocket, instead of the
  one-shot request/response model. Configure a base path under `config.sessions`
  and get four routes for free: `POST <path>` creates a session (spawns the
  command, bound to the caller's principal) and returns `{"id": "..."}`,
  `POST <path>/:id/input` writes raw body bytes to the command's stdin,
  `POST <path>/:id/end` closes stdin, and `GET <path>/:id/events` streams the
  command's stdout lines back as Server-Sent Events (with heartbeat comments
  and an `end` event on exit). Sessions are bound to the principal that
  created them — a different principal gets a `404`, never a distinguishable
  403. `idleTimeout`, `maxDuration`, and `maxPerPrincipal` bound how long a
  session can run idle, run in total, and how many a single principal can have
  open at once. On client disconnect (or either timeout), the command is
  killed with `SIGTERM` then escalated to `SIGKILL` if it doesn't exit in time.
- **WebSocket stream routes** — `config.ws` route entries now accept
  `stream: true` + `command` instead of the lifecycle `routes` map: the whole
  connection becomes one long-lived command session, with every client frame
  (text or binary) written to the command's stdin and every stdout line sent
  back as a text frame. Uses the same session manager, timeouts, and cap as
  the REST session routes.

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
