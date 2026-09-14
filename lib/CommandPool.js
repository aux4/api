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

  async execute(command, stdinData, timeout, envOverrides) {
    await this.acquire(timeout);
    try {
      return await Command.execute(command, stdinData, timeout, envOverrides);
    } finally {
      this.release();
    }
  }

  // Run a trusted in-process operation under the same concurrency budget as
  // child commands. A timed-out JavaScript operation cannot be forcibly killed,
  // so its slot is retained until it actually settles; the AbortSignal lets a
  // cooperative handler stop promptly without allowing ignored cancellation to
  // exceed maxConcurrency.
  async run(operation, timeout) {
    await this.acquire(timeout);

    const controller = new AbortController();
    let timer;
    let timedOut = false;
    const task = Promise.resolve().then(() => operation(controller.signal));
    const settled = task.finally(() => this.release());
    // The caller observes task/race below. Mark this derived promise handled so
    // a late handler rejection after a timeout never becomes unhandled.
    settled.catch(() => {});

    if (!timeout) return task;

    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new CommandPoolTimeoutError("Handler execution timed out"));
      }, timeout);
    });

    try {
      return await Promise.race([task, deadline]);
    } finally {
      if (!timedOut && timer) clearTimeout(timer);
    }
  }

  stream(command, stdinData, timeout, envOverrides) {
    if (this.running >= this.maxConcurrency && this.queue.length >= this.maxQueue) {
      throw new CommandPoolFullError();
    }

    this.running++;
    const child = Command.stream(command, stdinData, timeout, envOverrides);

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
  constructor(message = "Request timed out waiting for available slot") {
    super(message);
    this.name = "CommandPoolTimeoutError";
  }
}

module.exports = { CommandPool, CommandPoolFullError, CommandPoolTimeoutError };
