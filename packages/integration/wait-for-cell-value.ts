import { defer } from "@commonfabric/utils/defer";
import { stuckNet } from "@commonfabric/test-support/stuck-net";
import type { Cell, Runtime } from "@commonfabric/runner";

/**
 * Resolve with `cell`'s value once `predicate` accepts it at a quiescent
 * moment.
 *
 * The predicate is only ever applied to a value read after `runtime.idle()`,
 * never to one the sink reports mid-flight. A cell passes through states that
 * exist only until the scheduler drains — a query that has not yet re-run
 * against new inputs still holds its previous settled result, and a predicate
 * such as "settled and without error" accepts that superseded value. Reading
 * only at quiescence steps over those states.
 *
 * Between attempts the wait sleeps on the sink rather than on a timer: the
 * callback wakes it on every committed change, so there is no poll interval
 * under the latency and no iteration cap over it. `predicate` takes
 * `T | undefined` because a cell holds no value until its piece writes one.
 *
 * `stuckLabel` adds a stuck-condition net, and names the condition in the
 * failure it raises. A wait in a process that goes quiet needs none: Deno's
 * runner reports the pending promise and fails the test at once. A wait in a
 * process holding a live connection open does, since nothing there goes quiet
 * and the wait would otherwise run to the ambient job limit with nothing said
 * about what it was waiting for.
 */
export async function waitForCellValue<T>(
  runtime: Runtime,
  // deno-lint-ignore no-explicit-any
  cell: Cell<any>,
  predicate: (value: T | undefined) => boolean,
  options?: { stuckLabel?: string },
): Promise<T> {
  let changed = defer<void>();
  const cancel = cell.sink(() => {
    changed.resolve();
    changed = defer<void>();
  });
  const stuck = options?.stuckLabel === undefined
    ? undefined
    : stuckNet(options.stuckLabel);
  try {
    while (true) {
      await runtime.idle();
      // Captured before the read, so a change racing the predicate wakes the
      // next attempt instead of being missed.
      const next = changed.promise;
      const value = cell.get() as T;
      if (predicate(value)) return value;
      await (stuck === undefined ? next : Promise.race([next, stuck.rejects]));
    }
  } finally {
    stuck?.clear();
    // Cancelling while the action that reported a value is still finalizing
    // does not stick, because finalizing an action resubscribes it.
    await runtime.idle();
    cancel();
  }
}
