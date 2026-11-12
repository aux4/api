import { appendFileSync } from "node:fs";

function record(env, value) {
  appendFileSync(env.STRICT_ORDER_FILE, `${value}\n`);
}

export async function pullFromEnv(env) {
  record(env, "pull");
  if (env.CLOUD_STATE_ENABLED === "false") return { skipped: true };
  if (env.STRICT_SYNC_MODE === "pre-ok-false") return { complete: true, ok: false };
  if (env.STRICT_SYNC_MODE === "fail-once") {
    if (!globalThis.__strictPulls) {
      globalThis.__strictPulls = true;
      throw Object.assign(new Error("pull unavailable"), { statusCode: 503 });
    }
  }
  if (env.STRICT_SYNC_MODE === "incomplete") return { complete: false };
  return { complete: true };
}

export async function pushFromEnv(env) {
  record(env, "push");
  if (env.CLOUD_STATE_ENABLED === "false") return { skipped: true };
  if (env.STRICT_SYNC_MODE === "post-ok-false") return { pushed: 0, deleted: 0, ok: false };
  if (env.STRICT_SYNC_MODE === "push-fail") throw new Error("push unavailable");
  return { ok: true };
}
