/**
 * Simple concurrency limiter for async operations.
 * Limits how many requests can be in-flight simultaneously.
 */
export class RequestQueue {
  private running = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number) {}

  /**
   * Run an async function with concurrency limiting.
   * Waits for a slot if all slots are occupied, then executes.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrency) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    }

    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}

/** Limits concurrent fetch/stream HTTP requests. */
export const fetchQueue = new RequestQueue(6);

/** Limits concurrent LLM API requests. */
export const llmQueue = new RequestQueue(3);
