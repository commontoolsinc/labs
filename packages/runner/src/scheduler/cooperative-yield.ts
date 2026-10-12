// The scheduler's cooperative macrotask yield.
//
// Why: the settle loop (`settle.ts`) runs every action of a pass on one
// microtask chain, with no macrotask boundary from the first run to the
// last. Everything that rides the macrotask queue waits for the pass to
// end: the socket's frames, so a watch response the pass's own actions
// wait for is read only after the pass; a serving runtime's flush
// deadline and lease renew, whose timers can fall due seconds late
// behind a long wave; the memory server's push flush. The resume
// pre-sync's waves (`runner.ts`) and cooperative CFC preparation
// (`extended-storage-transaction.ts`) hold one of these for the same
// reason: each issues work in a loop that would otherwise send for
// seconds while the answers to its first frames waited unread.
//
// What: a time-sliced yield. `maybeYield()` is called between units of
// work; when the current slice of continuous work has run longer than
// `sliceMs` it awaits one macrotask turn (`setTimeout(0)`, the one
// primitive that lets DUE timers fire in deadline order before it
// resumes; measured on Deno: a MessageChannel turn or `setImmediate`
// let 0–2 of 8 due timers fire across a 360-ms loop, `setTimeout(0)`
// all 8 within a few ms of their deadlines) and reports the slice to the
// installed observer FIRST, synchronously. The serving loop's mid-wave
// lease renew rides that hook, so it never depends on the timer queue
// being serviced.
//
// Bound, stated honestly: a timer or a frame is attended to within ONE
// unit of work plus a slice. An action's per-demander instance runs (a
// 250-ms demand walk × its demanders) and its union-log resubscribe
// still run to their end; nothing here shortens the WORK. The yield is
// NOT placed inside the fan-out loop (see run.ts's note): a macrotask
// there let a run's own async seal refusal re-enter the pass.

import { getLogger } from "@commonfabric/utils/logger";

const logger = getLogger("cooperative-yield", {
  enabled: true,
  level: "warn",
});

/** One frame's worth of continuous work per macrotask turn. Sized against
 * the yield's own cost (~2 ms per `setTimeout(0)` on Deno) and the serving
 * loop's deadline granularity (T_flush 100 ms): ≤ ~12 % overhead on
 * pure-CPU runs, far less on the 20–250-ms demand walks the serving loop
 * was measured on, and a deadline honest to within one run + this slice. */
export const DEFAULT_YIELD_SLICE_MS = 16;

export class CooperativeYield {
  readonly #sliceMs: number;
  #sliceStart = performance.now();
  #yields = 0;

  /** The mid-wave hook (the SpaceServer's lease renew): called
   * synchronously at every yield, BEFORE the macrotask turn. */
  onYield: (() => void) | undefined;

  constructor(sliceMs: number = DEFAULT_YIELD_SLICE_MS) {
    this.#sliceMs = sliceMs;
  }

  /** DIAGNOSTIC (tests): macrotask turns taken so far. */
  get yieldCount(): number {
    return this.#yields;
  }

  /** The caller just crossed a macrotask boundary of its own (a new
   * execute pass): restart the slice clock so an idle gap does not read
   * as spent work. */
  noteMacrotaskBoundary(): void {
    this.#sliceStart = performance.now();
  }

  /**
   * Yield one macrotask turn iff the current slice is spent. Returns
   * `undefined` when there is nothing to await, so a caller can skip the
   * `await` (and its microtask hop) entirely on the hot path.
   */
  maybeYield(): Promise<void> | undefined {
    if (performance.now() - this.#sliceStart < this.#sliceMs) {
      return undefined;
    }
    return this.yieldNow();
  }

  /** Yield one macrotask turn unconditionally: report the slice to the
   * observer (synchronously — see the header), then let due timers run. */
  yieldNow(): Promise<void> {
    this.#yields += 1;
    try {
      this.onYield?.();
    } catch (error) {
      // The observer is the serving loop's; a throw there must not take
      // the scheduler down with it (same containment posture as the
      // replica's observer seams).
      logger.warn("yield-observer-failed", () => [
        "cooperative-yield observer threw",
        error,
      ]);
    }
    return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(
      () => {
        this.#sliceStart = performance.now();
      },
    );
  }
}
