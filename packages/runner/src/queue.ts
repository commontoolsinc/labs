export interface QueueConfig {
  maxConcurrency: number;
}

export interface QueueStats {
  pending: number;
  active: number;
  completed: number;
  failed: number;
}

interface QueueItem<T> {
  fn: () => Promise<T>;
  resolvers: PromiseWithResolvers<T>;
}

export class AsyncSemaphoreQueue {
  #maxConcurrency: number;
  #queue: QueueItem<unknown>[] = [];
  #active: number = 0;
  #completed: number = 0;
  #failed: number = 0;

  constructor(config: QueueConfig) {
    this.#maxConcurrency = config.maxConcurrency;
  }

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const resolvers = Promise.withResolvers<T>();
    this.#queue.push({ fn, resolvers } as QueueItem<unknown>);
    this.#drain();
    return resolvers.promise;
  }

  get stats(): QueueStats {
    return {
      pending: this.#queue.length,
      active: this.#active,
      completed: this.#completed,
      failed: this.#failed,
    };
  }

  setMaxConcurrency(n: number): void {
    this.#maxConcurrency = n;
    this.#drain();
  }

  #drain(): void {
    while (this.#active < this.#maxConcurrency && this.#queue.length > 0) {
      const item = this.#queue.shift();
      if (!item) {
        break;
      }

      this.#active++;
      const { fn, resolvers } = item;

      fn().then(
        (result) => {
          this.#active--;
          this.#completed++;
          resolvers.resolve(result);
          this.#drain();
        },
        (error) => {
          this.#active--;
          this.#failed++;
          resolvers.reject(error);
          this.#drain();
        },
      );
    }
  }
}
