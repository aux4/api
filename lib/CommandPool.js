const Command = require("./Command");

const DEFAULT_MAX_CONCURRENCY = 50;
const DEFAULT_MAX_QUEUE = 200;

class CommandPool {
  constructor(options = {}) {
    this.maxConcurrency = options.maxConcurrency || DEFAULT_MAX_CONCURRENCY;
    this.maxQueue = options.maxQueue || DEFAULT_MAX_QUEUE;
    this.running = 0;
    this.queue = [];
  }

  acquire(timeout) {
    if (this.running < this.maxConcurrency) {
      this.running++;
      return Promise.resolve();
    }

    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new CommandPoolFullError());
    }

    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };

      if (timeout) {
        entry.timer = setTimeout(() => {
          const index = this.queue.indexOf(entry);
          if (index !== -1) this.queue.splice(index, 1);
          reject(new CommandPoolTimeoutError());
        }, timeout);
      }

      this.queue.push(entry);
    });
  }

  release() {
    this.running--;

    if (this.queue.length > 0) {
      const entry = this.queue.shift();
      if (entry.timer) clearTimeout(entry.timer);
      this.running++;
      entry.resolve();
    }
  }

  async execute(command, stdinData, timeout) {
    await this.acquire(timeout);
    try {
      return await Command.execute(command, stdinData, timeout);
    } finally {
      this.release();
    }
  }

  stream(command, stdinData, timeout) {
    if (this.running >= this.maxConcurrency && this.queue.length >= this.maxQueue) {
      throw new CommandPoolFullError();
    }

    this.running++;
    const child = Command.stream(command, stdinData, timeout);

    child.on("exit", () => {
      this.release();
    });

    return child;
  }
}

class CommandPoolFullError extends Error {
  constructor() {
    super("Server too busy");
    this.name = "CommandPoolFullError";
  }
}

class CommandPoolTimeoutError extends Error {
  constructor() {
    super("Request timed out waiting for available slot");
    this.name = "CommandPoolTimeoutError";
  }
}

module.exports = { CommandPool, CommandPoolFullError, CommandPoolTimeoutError };
