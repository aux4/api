const { execFileSync } = require("child_process");
const fs = require("fs");

// A warm aux4 daemon that command-backed routes reuse instead of cold-starting
// the aux4 CLI (~200ms) on every request. The win compounds when a route's
// command itself shells out to further `aux4` commands — the daemon serves each
// nested call from the already-parsed, already-loaded process (its session token
// lets nested calls re-enter without deadlocking).
//
// The api server OWNS this daemon: started when the server starts, stopped when
// it stops. Command.js spawns route commands from AUX4_COMMAND_DAEMON_DIR with
// the daemon enabled; everything here is best-effort — if the daemon can't
// start, route commands transparently fall back to cold spawns.

// Unix socket paths have a ~104-char limit, and the socket lives next to this
// directory, so it MUST be short. Deliberately NOT os.tmpdir() — on macOS that's
// a long /var/folders/… path that overflows the limit. A caller (e.g. the cloud
// runtime) may override with AUX4_COMMAND_DAEMON_DIR, but it too must be short
// and writable (in Lambda the app dir is read-only, so /tmp is required).
function daemonDir() {
  return process.env.AUX4_COMMAND_DAEMON_DIR || "/tmp/aux4-api-daemon";
}

let started = false;

// Start the warm daemon and point Command.js at it. Skipped when explicitly
// disabled (AUX4_API_NO_COMMAND_DAEMON) or already started. Never throws.
function start() {
  if (started) return;
  if (process.env.AUX4_API_NO_COMMAND_DAEMON) return;
  const dir = daemonDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    // `aux4 aux4 daemon start` self-daemonizes (spawns a detached
    // `aux4 -daemon-server <socket>` and returns), so this does not block. Run it
    // FROM `dir` so the socket lands there; drop AUX4_NO_DAEMON so it actually
    // starts the server even when the parent runs daemonless.
    const env = { ...process.env };
    delete env.AUX4_NO_DAEMON;
    execFileSync("aux4", ["aux4", "daemon", "start"], { cwd: dir, env, stdio: "ignore", timeout: 15000 });
    process.env.AUX4_COMMAND_DAEMON_DIR = dir;
    started = true;
    console.log(`aux4 api: warm command daemon started at ${dir}`);
  } catch (err) {
    console.error(`aux4 api: command daemon start failed (${err.message}); route commands will cold-spawn`);
  }
}

// Stop the daemon (best-effort). Called on server shutdown. In Lambda the
// container is frozen/killed rather than stopped gracefully, so this mainly
// matters for a locally-run `aux4 api start`.
function stop() {
  if (!started) return;
  started = false;
  try {
    execFileSync("aux4", ["aux4", "daemon", "stop"], { cwd: daemonDir(), stdio: "ignore", timeout: 10000 });
  } catch {}
}

module.exports = { start, stop, daemonDir };
