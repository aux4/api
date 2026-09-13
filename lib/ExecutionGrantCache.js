// Container-local only: credentials must never be serialized or logged.
const MAX_ENTRIES = 128;
const MAX_AGE_MS = 5 * 60 * 1000;
const SAFETY_MS = 30 * 1000;

function cacheDeadline(grant, now) {
  const expiries = [];
  for (const name of ["expiresAt", "executionExpiresAt"]) {
    if (grant[name] !== undefined) {
      const value = Number(grant[name]);
      if (!Number.isFinite(value) || value <= 0) return now;
      expiries.push(value * 1000);
    }
  }
  // Decoding exp is only an additional upper bound, never token verification.
  try {
    const payload = JSON.parse(Buffer.from(grant.accessToken.split(".")[1], "base64url").toString());
    if (payload.exp !== undefined) {
      if (!Number.isFinite(payload.exp) || payload.exp <= 0) return now;
      expiries.push(payload.exp * 1000);
    }
  } catch { /* Opaque tokens use the control plane's expiry. */ }
  if (!expiries.length) return now;
  return Math.min(now + MAX_AGE_MS, ...expiries.map(expiry => expiry - SAFETY_MS));
}

class ExecutionGrantCache {
  constructor() { this.entries = new Map(); }

  get(executionId, now = Date.now()) {
    this.prune(now);
    const entry = this.entries.get(executionId);
    if (!entry) return null;
    this.entries.delete(executionId);
    this.entries.set(executionId, entry);
    return entry.grant;
  }

  set(executionId, grant, now = Date.now()) {
    this.prune(now);
    this.delete(executionId);
    const deadline = cacheDeadline(grant, now);
    if (deadline <= now) return;
    while (this.entries.size >= MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value);
    this.entries.set(executionId, { grant, deadline });
  }

  delete(executionId) { this.entries.delete(executionId); }

  prune(now) {
    for (const [id, entry] of this.entries) {
      if (entry.deadline <= now) this.entries.delete(id);
    }
  }
}

module.exports = { ExecutionGrantCache, cacheDeadline };
