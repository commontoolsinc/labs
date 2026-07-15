/** Trailing quiet period before a wake flush. Interactive client work commits
 * in bursts (one UI step is several source commits); recomputing per wire push
 * makes the Worker race every next commit into a conflict. One bounded window
 * lets a burst integrate as one recompute — a settlement may already cover
 * multiple source invalidations, so coalescing changes no protocol shape. */
export const SELECTIVE_WAKE_COALESCE_WINDOW_MS = 25;
/** Hard cap from the first deferred push, so a continuous commit stream still
 * makes progress instead of sliding the window forever. */
export const SELECTIVE_WAKE_COALESCE_MAX_WINDOW_MS = 100;

export interface SelectiveDemandWakeQueueOptions {
  /** Trailing quiet period; re-armed by each push while under the cap. */
  readonly windowMs?: number;
  /** Upper bound on total deferral from the first deferred push. */
  readonly maxWindowMs?: number;
  readonly setTimer?: (callback: () => void, delayMs: number) => number;
  readonly clearTimer?: (timer: number) => void;
  readonly now?: () => number;
}

/** Coalesces host-pushed stale scheduler identities into the smallest ordered
 * pull batches. A commit arriving while a pull is in flight is retained for a
 * following batch before the queue reports settled; a commit arriving while
 * the queue is idle opens one bounded coalescing window instead of flushing
 * per push. */
export class SelectiveDemandWakeQueue {
  readonly #pending = new Set<string>();
  #scheduled = false;
  #idle: PromiseWithResolvers<void> | null = null;
  readonly #windowMs: number;
  readonly #maxWindowMs: number;
  readonly #setTimer: (callback: () => void, delayMs: number) => number;
  readonly #clearTimer: (timer: number) => void;
  readonly #now: () => number;
  #timer: number | null = null;
  #windowStartedAt: number | null = null;

  constructor(
    private readonly flush: (pieceIds: readonly string[]) => Promise<void>,
    options: SelectiveDemandWakeQueueOptions = {},
  ) {
    this.#windowMs = options.windowMs ?? SELECTIVE_WAKE_COALESCE_WINDOW_MS;
    this.#maxWindowMs = options.maxWindowMs ??
      SELECTIVE_WAKE_COALESCE_MAX_WINDOW_MS;
    this.#setTimer = options.setTimer ??
      ((callback, delayMs) =>
        setTimeout(callback, delayMs) as unknown as number);
    this.#clearTimer = options.clearTimer ??
      ((timer) =>
        clearTimeout(timer as unknown as ReturnType<typeof setTimeout>));
    this.#now = options.now ?? (() => performance.now());
  }

  push(pieceIds: readonly string[]): void {
    for (const pieceId of pieceIds) this.#pending.add(pieceId);
    if (this.#pending.size === 0 || this.#scheduled) return;
    if (this.#idle === null) {
      const idle = Promise.withResolvers<void>();
      // A later settled() caller observes this same promise. Mark the internal
      // branch handled so a pull failure cannot become an ambient unhandled
      // rejection before the Worker reaches its explicit settle barrier.
      void idle.promise.catch(() => undefined);
      this.#idle = idle;
    }
    // (Re)arm the trailing window, never sliding past the cap.
    const now = this.#now();
    if (this.#windowStartedAt === null) this.#windowStartedAt = now;
    const capRemaining = Math.max(
      0,
      this.#windowStartedAt + this.#maxWindowMs - now,
    );
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      this.#windowStartedAt = null;
      this.#startDrain();
    }, Math.min(this.#windowMs, capRemaining));
  }

  settled(): Promise<void> {
    return this.#idle?.promise ?? Promise.resolve();
  }

  #startDrain(): void {
    if (this.#scheduled || this.#pending.size === 0) return;
    const idle = this.#idle;
    if (idle === null) return;
    this.#scheduled = true;
    void this.#drain(idle);
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
