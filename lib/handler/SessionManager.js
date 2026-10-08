const readline = require("readline");
const { v7: uuidv7 } = require("uuid");
const Command = require("../Command");

const DEFAULT_IDLE_TIMEOUT = 60000; // ms with no stdin/stdout activity
const DEFAULT_MAX_DURATION = 30 * 60 * 1000; // ms total session lifetime
const DEFAULT_MAX_PER_PRINCIPAL = 5;
const KILL_ESCALATION_GRACE = 2000; // ms between SIGTERM and SIGKILL
const REAP_GRACE = 30000; // ms a session with no live subscriber survives after exit

// Generic, command-agnostic manager for long-lived "session" child processes:
// spawn a configured command, keep its stdin open, let callers feed it bytes
// over time, and stream its stdout lines back to one subscriber at a time.
// Used by both the REST session routes (SessionHandler) and WebSocket stream
// routes (WebSocketHandler), so the cap-per-principal / idle-timeout /
// max-duration / kill-escalation behavior is implemented exactly once.
//
// Nothing here knows about any particular command (whisper or otherwise) —
// the command string is fully assembled by the caller from route config plus
// JSON-escaped flag values (see ArgsBuilder). This module only manages the
// process lifecycle and the principal binding.
class SessionManager {
  constructor() {
    this.sessions = new Map();
  }

  principalKey(principal) {
    if (!principal) return "__anonymous__";
    return principal.sub || principal.email || principal.principalId || JSON.stringify(principal);
  }

  countForPrincipal(key) {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.principalKey === key) count++;
    }
    return count;
  }

  // Creates a new session bound to `principal` and spawns `command`. Throws a
  // SessionLimitError when the creating principal already has
  // `maxPerPrincipal` concurrent sessions.
  create(command, principal, options = {}) {
    const key = this.principalKey(principal);
    const maxPerPrincipal = options.maxPerPrincipal ?? DEFAULT_MAX_PER_PRINCIPAL;

    if (this.countForPrincipal(key) >= maxPerPrincipal) {
      throw new SessionLimitError();
    }

    const idleTimeoutMs = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
    const maxDurationMs = options.maxDuration ?? DEFAULT_MAX_DURATION;

    const id = uuidv7();
    const child = Command.openStream(command);

    const session = {
      id,
      principal,
      principalKey: key,
      child,
      lines: [],
      ended: false,
      exitCode: null,
      onLine: null,
      onExit: null,
      createdAt: Date.now()
    };

    const resetIdle = () => {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      session.idleTimer = setTimeout(() => this.kill(id), idleTimeoutMs);
    };
    session.resetIdle = resetIdle;
    resetIdle();

    session.maxDurationTimer = setTimeout(() => this.kill(id), maxDurationMs);

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", line => {
      resetIdle();
      if (session.onLine) {
        session.onLine(line);
      } else {
        session.lines.push(line);
      }
    });

    child.on("exit", code => {
      session.ended = true;
      session.exitCode = code;
      clearTimeout(session.idleTimer);
      clearTimeout(session.maxDurationTimer);

      if (session.onExit) {
        session.onExit(code);
      } else {
        // No live subscriber yet (client hasn't opened the events stream /
        // WS). Keep the session + its buffered output around briefly so a
        // late subscriber can still retrieve it, then reap it.
        session.reapTimer = setTimeout(() => this.remove(id), REAP_GRACE);
      }
    });

    this.sessions.set(id, session);
    return session;
  }

  // Looks a session up AND enforces the principal binding in one step: a
  // session created by a different principal (or an unauthenticated caller
  // when the session was created by an authenticated one, or vice versa) is
  // treated exactly like "not found" by the caller — never surfaced as a
  // distinct 403, so its existence/ownership can't be probed.
  get(id, principal) {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.principalKey !== this.principalKey(principal)) return null;
    return session;
  }

  // Writes raw bytes/text to the session's stdin. Returns false if the
  // session doesn't exist, belongs to a different principal, or has already
  // ended.
  input(id, principal, data) {
    const session = this.get(id, principal);
    if (!session || session.ended) return false;
    session.resetIdle();
    try {
      session.child.stdin.write(data);
      return true;
    } catch {
      return false;
    }
  }

  // Closes stdin (signals EOF to the command) without killing the process —
  // lets it flush any final output before exiting on its own.
  end(id, principal) {
    const session = this.get(id, principal);
    if (!session) return false;
    try {
      session.child.stdin.end();
      return true;
    } catch {
      return false;
    }
  }

  // Attaches the single live subscriber for a session's output (an SSE
  // response or a WebSocket connection). Replays any output buffered before
  // the subscriber attached, then streams live. If the command already
  // exited before anyone subscribed, onExit fires immediately (after replay).
  subscribe(id, principal, { onLine, onExit }) {
    const session = this.get(id, principal);
    if (!session) return null;

    if (session.reapTimer) {
      clearTimeout(session.reapTimer);
      session.reapTimer = null;
    }

    for (const line of session.lines) onLine(line);
    session.lines = [];
    session.onLine = onLine;
    session.onExit = onExit;

    if (session.ended) onExit(session.exitCode);

    return session;
  }

  unsubscribe(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.onLine = null;
    session.onExit = null;
  }

  // Idle-timeout / max-duration teardown: SIGTERM first, SIGKILL if the
  // process hasn't exited within the grace period.
  kill(id) {
    const session = this.sessions.get(id);
    if (!session || session.ended) return;

    Command.killProcessGroup(session.child);

    const escalate = setTimeout(() => {
      try {
        if (process.platform !== "win32") {
          process.kill(-session.child.pid, "SIGKILL");
        } else {
          session.child.kill();
        }
      } catch {
        // already dead
      }
    }, KILL_ESCALATION_GRACE);

    session.child.on("exit", () => clearTimeout(escalate));
  }

  // Client-disconnect teardown: kill the process (SIGTERM -> SIGKILL) and
  // remove the session immediately — there is nobody left to replay to.
  destroy(id) {
    this.kill(id);
    this.remove(id);
  }

  remove(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    clearTimeout(session.idleTimer);
    clearTimeout(session.maxDurationTimer);
    clearTimeout(session.reapTimer);
    this.sessions.delete(id);
  }

  size() {
    return this.sessions.size;
  }
}

class SessionLimitError extends Error {
  constructor() {
    super("Session limit reached for this principal");
    this.name = "SessionLimitError";
  }
}

module.exports = { SessionManager, SessionLimitError };
