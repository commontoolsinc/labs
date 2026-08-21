import type { Logger } from "@commonfabric/utils/logger";

import type { Cell } from "../cell.ts";
import type { Runtime } from "../runtime.ts";

/**
 * Seed a list coordinator's result container with `[]` once `pull` settles, if
 * the container is still absent at that point.
 *
 * A resume reconcile that reads an undefined container defers instead of
 * reconciling against a value that has not arrived, and pulls the container so
 * that the value's arrival re-triggers the reconcile. A container that was
 * never persisted has no value to arrive: the pull settles with the container
 * still undefined, and the coordinator waits for a re-trigger that nothing will
 * send. The seed ends that wait by writing the empty array a fresh coordinator
 * would have written, which re-triggers the reconcile the same way a durable
 * value would have.
 *
 * The seed belongs to the deferral that started it, so it writes to `container`
 * and to nothing else. `stillHeld` reports whether the coordinator is still
 * holding that same container: a coordinator that has been torn down holds
 * nothing, and one that has swapped in a replacement defers and seeds for the
 * replacement through its own reconcile, which is what confirms the
 * replacement's own state before anything writes to it.
 *
 * `stillHeld` is asked once before the transaction opens, so that a torn-down
 * coordinator does not reach into a runtime that is shutting down, and again
 * inside the transaction body, which `editWithRetry` re-runs per attempt after
 * awaiting a conflict's catch-up gate. A commit already in flight is beyond
 * either question, since `editWithRetry` takes no cancellation, so the window
 * that remains is the span between an attempt's writes and its commit
 * landing.
 *
 * The seed runs whether the pull resolved or rejected, because a rejected pull
 * leaves the container as absent as a resolved one does. A rejected pull and a
 * failed seed are each reported through `logger`. The returned promise resolves
 * once the pull and the seed have both settled, and rejects for neither.
 *
 * The chain is registered with the storage manager's settle barrier, so
 * `Cell.pull()` and `storageManager.synced()` hold until the seed's write has
 * settled. The pull reaches that barrier through the replica's own sync
 * bookkeeping, and this registration carries the wait across the span between
 * the pull settling and the seed's commit being issued.
 * `Runtime.dispose({ closeStorage: false })` drains the runtime through
 * `settled(Infinity)` before it tears anything down, so the store a reader is
 * handed afterwards carries whatever the seed wrote. A caller does not register
 * the returned promise; this function registers the chain.
 */
export function seedResultContainerWhenPullSettles(
  runtime: Runtime,
  container: Cell<any[]>,
  stillHeld: () => boolean,
  pull: Promise<unknown>,
  logger: Logger,
): Promise<void> {
  const seedIfStillAbsent = (): Promise<void> => {
    if (!stillHeld()) return Promise.resolve();
    return runtime.editWithRetry((seedTx) => {
      if (!stillHeld()) return;
      const scoped = container.withTx(seedTx);
      if (scoped.getRaw() === undefined) scoped.set([]);
    }).then(({ error }) => {
      if (error) {
        logger.warn(
          "resume-seed",
          "seeding the empty result container failed",
          { error },
        );
      }
    });
  };
  const settled = pull.finally(seedIfStillAbsent).then(
    () => {},
    (error: unknown) => {
      logger.warn("resume-pull", "resume container pull rejected", { error });
    },
  );
  runtime.storageManager.trackUntilSettled(settled);
  return settled;
}
