/**
 * A bound on how long a wait may go without the thing being waited on
 * reporting progress. A flat timeout bounds the whole wait, so it caps what a
 * slow but healthy run can complete; a stall bound caps only the gap between
 * two reports of progress, so a run that keeps working is never cut off, and
 * one that has stopped working is still reported after the bound.
 *
 * `docs/development/waiting-in-tests.md` has the argument: wall-clock time is
 * not a measure of progress, and a bound is acceptable to the degree that its
 * early fire is safe. A stall bound still counts wall-clock time, so a paused
 * machine can trip it; what it no longer does is fire on work that is merely
 * taking a while.
 */
export class StallWatchdog {
  readonly #boundMs: number;
  readonly #now: () => number;
  #lastProgressAt: number;

  /**
   * `boundMs` is the longest gap allowed between two calls of `progress()`
   * while a watch is armed. `now` is the clock, a millisecond counter; the
   * default is `performance.now()`, and a test passes one it controls.
   */
  constructor(boundMs: number, now: () => number = () => performance.now()) {
    this.#boundMs = boundMs;
    this.#now = now;
    this.#lastProgressAt = now();
  }

  /** Records that the watched thing made progress just now. */
  progress(): void {
    this.#lastProgressAt = this.#now();
  }

  /**
   * Arms a watch: `promise` rejects with an `Error` carrying `message` once
   * `boundMs` pass without a `progress()` call, counted from this call. It
   * never resolves, so it is only useful raced against the awaited work.
   * `stop()` disarms it; call that once the race is decided, or the pending
   * timer holds the event loop open.
   */
  watch(message: string): { promise: Promise<never>; stop(): void } {
    this.progress();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<never>((_, reject) => {
      const arm = () => {
        const remaining = this.#boundMs - (this.#now() - this.#lastProgressAt);
        if (remaining <= 0) {
          timer = undefined;
          reject(new Error(message));
          return;
        }
        // The timer is set for the earliest moment the bound can have
        // elapsed, and re-armed from there whenever progress arrived in the
        // meantime. That is a deadline that moves, not a poll: the timer
        // fires once per bound at most, however much progress there is.
        timer = setTimeout(arm, remaining);
      };
      arm();
    });
    return {
      promise,
      stop: () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      },
    };
  }
}
