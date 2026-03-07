const DEFAULT_MAX_KEYS = 10000;

class RateLimiter {
  constructor(options = {}) {
    this.maxKeys = options.maxKeys || DEFAULT_MAX_KEYS;
    this.windows = new Map();
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  check(key, max, timeWindow) {
    const now = Date.now();
    const windowStart = now - timeWindow;

    let timestamps = this.windows.get(key);
    if (!timestamps) {
      if (this.windows.size >= this.maxKeys) {
        this.evictOldest();
      }
      timestamps = [];
      this.windows.set(key, timestamps);
    }

    // Remove expired timestamps
    while (timestamps.length > 0 && timestamps[0] <= windowStart) {
      timestamps.shift();
    }

    if (timestamps.length >= max) {
      const resetTime = timestamps[0] + timeWindow;
      return { allowed: false, remaining: 0, resetTime };
    }

    timestamps.push(now);
    const remaining = max - timestamps.length;
    const resetTime = timestamps[0] + timeWindow;
    return { allowed: true, remaining, resetTime };
  }

  evictOldest() {
    const first = this.windows.keys().next().value;
    if (first !== undefined) {
      this.windows.delete(first);
    }
  }

  cleanup() {
    const now = Date.now();
    for (const [key, timestamps] of this.windows) {
      if (timestamps.length === 0 || timestamps[timestamps.length - 1] < now - 300000) {
        this.windows.delete(key);
      }
    }
  }

  destroy() {
    clearInterval(this.cleanupInterval);
    this.windows.clear();
  }
}

module.exports = RateLimiter;
