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
 * `liveContainer` reports the container the coordinator holds when the pull
 * settles, not the one it held when it deferred. It reports `undefined` once
 * the coordinator has been torn down or has swapped in a different container,
 * and either way there is nothing here to seed: a torn-down coordinator owns no
 * container to write to, and a replacement container defers and seeds through
 * its own reconcile. Asking before the transaction opens is what keeps a
 * torn-down coordinator from reaching into a runtime that is shutting down.
 *
 * The seed runs whether the pull resolved or rejected, because a rejected pull
 * leaves the container as absent as a resolved one does. A rejected pull and a
 * failed seed are each reported through `logger`. The returned promise resolves
 * once the pull and the seed have both settled, and rejects for neither.
 */
export function seedResultContainerWhenPullSettles(
  runtime: Runtime,
  liveContainer: () => Cell<any[]> | undefined,
  pull: Promise<unknown>,
  logger: Logger,
): Promise<void> {
  const seedIfStillAbsent = (): Promise<void> => {
    const container = liveContainer();
    if (!container) return Promise.resolve();
    return runtime.editWithRetry((seedTx) => {
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
  return pull.finally(seedIfStillAbsent).then(() => {}, (error: unknown) => {
    logger.warn("resume-pull", "resume container pull rejected", { error });
  });
}
