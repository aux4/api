const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// A warm aux4 daemon that command-backed routes reuse instead of cold-starting
// the aux4 CLI (~200ms) on every request. The win compounds when a route's
// command itself shells out to several `aux4` commands — the daemon serves each
// (nested calls re-enter via its session token, aux4 core >= 5.2.6).
//
// The api server OWNS this daemon: started when the server starts, stopped when
// it stops. Everything is best-effort — if the daemon can't start, route
// commands transparently fall back to cold spawns.
//
// KEY: the socket lives at AUX4_DAEMON_SOCKET (aux4 core >= 5.2.7), a fixed
// writable path, and BOTH the daemon and its command clients agree on it via
// that env var. Nobody changes their working directory — an earlier approach put
// the socket next to the CWD and forced route commands to run from the daemon
// dir, which broke CWD-dependent commands (and the test suite). The daemon is
// still started from the server's own CWD so it loads the app's command library.

// Unix socket paths have a ~104-char limit, so this must be short. NOT
// os.tmpdir() (long /var/folders/… on macOS). In Lambda /tmp is the only
// writable dir. Override with AUX4_DAEMON_SOCKET.
function socketPath() {
  return process.env.AUX4_DAEMON_SOCKET || "/tmp/aux4-api-daemon.sock";
}

let started = false;

// Start the warm daemon. Skipped when explicitly disabled or already started.
// Never throws. Sets AUX4_DAEMON_SOCKET so this process's aux4 clients (the
// route commands Command.js spawns) discover the same socket.
function start() {
  if (started) return;
  if (process.env.AUX4_API_NO_COMMAND_DAEMON) return;
  const sock = socketPath();
  try {
    fs.mkdirSync(path.dirname(sock), { recursive: true });
    process.env.AUX4_DAEMON_SOCKET = sock;
    const env = { ...process.env, AUX4_DAEMON_SOCKET: sock };
    // Start the server even when the parent runs daemonless (cloud sets
    // AUX4_NO_DAEMON=1 so `api lambda-loop` itself doesn't route through a daemon).
    delete env.AUX4_NO_DAEMON;
    // No cwd override: run from the server's CWD so the daemon loads the app's
    // command library; the socket lands at `sock` via the env override, not here.
    execFileSync("aux4", ["aux4", "daemon", "start"], { env, stdio: "ignore", timeout: 15000 });
    started = true;
    console.log(`aux4 api: warm command daemon started (socket ${sock})`);
  } catch (err) {
    console.error(`aux4 api: command daemon start failed (${err.message}); route commands will cold-spawn`);
  }
}

// Stop the daemon (best-effort). In Lambda the container is frozen/killed rather
// than stopped gracefully, so this mainly matters for a local `aux4 api start`.
function stop() {
  if (!started) return;
  started = false;
  try {
    execFileSync("aux4", ["aux4", "daemon", "stop"], {
      env: { ...process.env, AUX4_DAEMON_SOCKET: socketPath() },
      stdio: "ignore",
      timeout: 10000
    });
  } catch {}
}

module.exports = { start, stop, socketPath };
