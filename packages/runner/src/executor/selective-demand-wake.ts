/** Coalesces host-pushed stale scheduler identities into the smallest ordered
 * pull batches. A commit arriving while a pull is in flight is retained for a
 * following batch before the queue reports settled. */
export class SelectiveDemandWakeQueue {
  readonly #pending = new Set<string>();
  #scheduled = false;
  #idle: PromiseWithResolvers<void> | null = null;

  constructor(
    private readonly flush: (pieceIds: readonly string[]) => Promise<void>,
  ) {}

  push(pieceIds: readonly string[]): void {
    for (const pieceId of pieceIds) this.#pending.add(pieceId);
    if (this.#pending.size === 0 || this.#scheduled) return;
    this.#scheduled = true;
    const idle = Promise.withResolvers<void>();
    // A later settled() caller observes this same promise. Mark the internal
    // branch handled so a pull failure cannot become an ambient unhandled
    // rejection before the Worker reaches its explicit settle barrier.
    void idle.promise.catch(() => undefined);
    this.#idle = idle;
    queueMicrotask(() => void this.#drain(idle));
  }

  settled(): Promise<void> {
    return this.#idle?.promise ?? Promise.resolve();
  }

  async #drain(idle: PromiseWithResolvers<void>): Promise<void> {
    try {
      while (this.#pending.size > 0) {
        const batch = [...this.#pending].sort();
        this.#pending.clear();
        await this.flush(batch);
      }
      idle.resolve();
    } catch (error) {
      this.#pending.clear();
      idle.reject(error);
    } finally {
      if (this.#idle === idle) this.#idle = null;
      this.#scheduled = false;
      // A push cannot interleave with synchronous finally work, but a custom
      // thenable may enqueue one immediately after flush resolution. Preserve
      // it if it became visible before the queue released its scheduled bit.
      if (this.#pending.size > 0) this.push([]);
    }
  }
}
