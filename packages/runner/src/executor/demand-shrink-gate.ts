/**
 * P0 demand-shrink gate (client-passivity plan, the demand-blip fix at the
 * PRODUCER).
 *
 * WHY: the client runner publishes its execution-demand set on every piece
 * start/stop, so a same-space navigation (stop piece A → start piece B)
 * publishes a transient EMPTY set between the two. Server-side claim
 * issuance re-validates the sponsor's live demand row at the instant of
 * claiming ("sponsor-demand-gone" — 53/53 refusals on the real workload),
 * and the pool aborts/drains on empty demand, so the blip breaks the whole
 * serving pipeline even though nothing actually departed. The pool-side
 * grace window (SharedExecutionPool.demandGraceMs) damps the consumer; this
 * gate removes the blip AT THE SOURCE: demand GROWTH publishes immediately,
 * demand SHRINK is held for `holdMs` and folded away when growth follows
 * within the window — the wire sees {A} → {B}, never {A} → {} → {B}.
 *
 * A genuine departure (nothing restarts within the hold) publishes the
 * shrunken set one hold later — the same bounded-lag semantics as the pool
 * grace, and teardown bypasses the hold entirely (`flushImmediate`), so a
 * clean shutdown still ends with a prompt empty snapshot. `holdMs: 0` is
 * byte-identical passthrough.
 */

export interface DemandShrinkGateOptions {
  holdMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (timer: number) => void;
}

type PendingShrink = {
  timer: number;
  pieces: readonly string[];
  publish: (pieces: readonly string[]) => void;
};

export class ExecutionDemandShrinkGate {
  readonly #holdMs: number;
  readonly #setTimer: (callback: () => void, delayMs: number) => number;
  readonly #clearTimer: (timer: number) => void;
  readonly #pending = new Map<string, PendingShrink>();

  constructor(options: DemandShrinkGateOptions = {}) {
    this.#holdMs = Math.max(0, options.holdMs ?? 10_000);
    this.#setTimer = options.setTimer ??
      ((callback, delayMs) =>
        setTimeout(callback, delayMs) as unknown as number);
    this.#clearTimer = options.clearTimer ??
      ((timer) =>
        clearTimeout(timer as unknown as ReturnType<typeof setTimeout>));
  }

  /** Demand grew (a piece started): cancel any held shrink for the space and
   * publish the CURRENT set immediately — the held shrink is superseded, so
   * the transient never reaches the wire. */
  grow(
    space: string,
    pieces: readonly string[],
    publish: (pieces: readonly string[]) => void,
  ): void {
    const pending = this.#pending.get(space);
    if (pending !== undefined) {
      this.#clearTimer(pending.timer);
      this.#pending.delete(space);
    }
    publish(pieces);
  }

  /** Demand shrank (a piece stopped): hold the publish for the hold window.
   * A later shrink inside the window replaces the held snapshot (the fire
   * publishes the LATEST set); growth cancels it entirely. */
  shrink(
    space: string,
    pieces: readonly string[],
    publish: (pieces: readonly string[]) => void,
  ): void {
    if (this.#holdMs === 0) {
      publish(pieces);
      return;
    }
    const pending = this.#pending.get(space);
    if (pending !== undefined) {
      pending.pieces = pieces;
      pending.publish = publish;
      return;
    }
    const entry: PendingShrink = {
      timer: 0,
      pieces,
      publish,
    };
    entry.timer = this.#setTimer(() => {
      if (this.#pending.get(space) !== entry) return;
      this.#pending.delete(space);
      entry.publish(entry.pieces);
    }, this.#holdMs);
    this.#pending.set(space, entry);
  }

  /** Teardown path: cancel the hold and publish NOW (a clean shutdown must
   * end with a prompt final snapshot, not a dangling timer). */
  flushImmediate(
    space: string,
    pieces: readonly string[],
    publish: (pieces: readonly string[]) => void,
  ): void {
    const pending = this.#pending.get(space);
    if (pending !== undefined) {
      this.#clearTimer(pending.timer);
      this.#pending.delete(space);
    }
    publish(pieces);
  }

  /** Cancel every held shrink without publishing (storage is going away). */
  dispose(): void {
    for (const pending of this.#pending.values()) {
      this.#clearTimer(pending.timer);
    }
    this.#pending.clear();
  }
}
