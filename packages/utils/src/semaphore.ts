/**
 * A counting semaphore for limiting concurrent async operations.
 * Uses a FIFO queue to ensure fair ordering of waiters.
 *
 * @example
 * ```typescript
 * import { Semaphore } from "@commontools/utils/semaphore";
 *
 * const sem = new Semaphore({ maxConcurrent: 4 });
 *
 * async function doWork() {
 *   await sem.acquire();
 *   try {
 *     // ... limited concurrent work
 *   } finally {
 *     sem.release();
 *   }
 * }
 * ```
 */

/**
 * Options for configuring a Semaphore.
 */
export interface SemaphoreOptions {
  /**
   * Maximum number of concurrent permits.
   */
  maxConcurrent: number;

  /**
   * Maximum number of waiters allowed in the queue.
   * When exceeded, `acquire()` rejects with `SemaphoreQueueFullError`.
   * If undefined, the queue is unbounded.
   */
  maxQueueDepth?: number;
}

/**
 * Error thrown when the semaphore queue is full.
 */
export class SemaphoreQueueFullError extends Error {
  constructor(maxQueueDepth: number) {
    super(`Semaphore queue full (max ${maxQueueDepth} waiters)`);
    this.name = "SemaphoreQueueFullError";
  }
}

/**
 * A counting semaphore for limiting concurrent async operations.
 */
export class Semaphore {
  private available: number;
  private readonly maxConcurrent: number;
  private readonly maxQueueDepth: number | undefined;
  private waitQueue: Array<() => void> = [];

  constructor(options: SemaphoreOptions) {
    this.maxConcurrent = options.maxConcurrent;
    this.available = options.maxConcurrent;
    this.maxQueueDepth = options.maxQueueDepth;
  }

  /**
   * Acquire a permit from the semaphore.
   * Blocks (via promise) if no permits are available.
   *
   * @throws {SemaphoreQueueFullError} If maxQueueDepth is set and the queue is full.
   */
  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }

    // Check queue depth limit
    if (
      this.maxQueueDepth !== undefined &&
      this.waitQueue.length >= this.maxQueueDepth
    ) {
      throw new SemaphoreQueueFullError(this.maxQueueDepth);
    }

    // No permits available, wait in queue
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  /**
   * Release a permit back to the semaphore.
   * If there are waiters, the next one in queue is awakened.
   */
  release(): void {
    const nextWaiter = this.waitQueue.shift();
    if (nextWaiter) {
      // Hand the permit directly to the next waiter
      nextWaiter();
    } else {
      // No waiters, return permit to pool
      this.available++;
    }
  }

  /**
   * Get the number of currently available permits.
   */
  get availablePermits(): number {
    return this.available;
  }

  /**
   * Get the number of waiters in the queue.
   */
  get queueLength(): number {
    return this.waitQueue.length;
  }

  /**
   * Get the maximum number of concurrent permits.
   */
  get maxPermits(): number {
    return this.maxConcurrent;
  }
}
