export type SchedulerEvent = {
  space: string;
  docId: string;
  path: string[];
  before: unknown;
  after: unknown;
};

export type SchedulerCb = (e: SchedulerEvent) => void;

export class Scheduler {
  #cbs = new Set<SchedulerCb>();
  on(cb: SchedulerCb): () => void {
    this.#cbs.add(cb);
    return () => this.#cbs.delete(cb);
  }
  emit(e: SchedulerEvent): void {
    for (const cb of this.#cbs) cb(e);
  }
}


