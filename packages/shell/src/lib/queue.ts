export type WorkQueueProcessor<T> = (job: T) => Promise<void>;

interface JobItem<T> {
  job: T;
  resolvers: PromiseWithResolvers<void>;
}

export class WorkQueue<T> {
  #active: boolean = false;
  #queue: JobItem<T>[] = [];
  #callback: WorkQueueProcessor<T>;

  constructor(processor: WorkQueueProcessor<T>) {
    this.#callback = processor;
  }

  submit(job: T) {
    const resolvers = Promise.withResolvers<void>();
    this.#queue.push({ job, resolvers });
    this.#loop();
    return resolvers.promise;
  }

  async #loop() {
    if (this.#active) {
      return;
    }

    const item = this.#queue.shift();
    if (!item) {
      return;
    }
    this.#active = true;
    const { job, resolvers } = item;

    await this.#callback(job).then(resolvers.resolve, resolvers.reject);
    this.#active = false;
    await this.#loop();
  }
}
