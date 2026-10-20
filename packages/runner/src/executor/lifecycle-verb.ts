// Shared by browser-reachable piece operations and the serving worker port.
// Keep these result types independent of the executor host and its store.

/**
 * One step the serving side timed while running a lifecycle verb: `phase`
 * names it as `<verb>.<step>`, `ms` is its length in whole milliseconds.
 */
export type LifecyclePhaseTiming = { phase: string; ms: number };

/**
 * What running a lifecycle verb from a descriptor yields: the verb's receipt,
 * and the steps the serving side timed in the order they happened — the
 * session it opened (`session`), the wait for a cycle of the loop to take the
 * verb (`queue`), the verb's run (`run`), the wave commit after it (`commit`)
 * and the durability read (`confirm`). A step that never finished is left
 * out.
 */
export type LifecycleVerbRun = {
  receipt: unknown;
  timings: LifecyclePhaseTiming[];
};

/** A failed lifecycle verb, retaining the phases completed before failure. */
export class LifecycleVerbFailure extends Error {
  readonly timings: LifecyclePhaseTiming[];
  readonly code: string | undefined;

  constructor(cause: unknown, timings: LifecyclePhaseTiming[]) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.timings = [...timings];
    this.name = cause instanceof Error ? cause.name : "Error";
    if (cause instanceof Error) this.stack = cause.stack;
    const code = cause instanceof Error
      ? (cause as { code?: unknown }).code
      : undefined;
    this.code = typeof code === "string" ? code : undefined;
  }
}
