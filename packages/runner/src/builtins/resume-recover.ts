import type { Cell, MemorySpace } from "../cell.ts";
import type { Pattern } from "../builder/types.ts";
import type { Runtime } from "../runtime.ts";
import type { Logger } from "@commonfabric/utils/logger";

type ElementRuns = Map<
  string,
  { resultCell: Cell<any>; lastIndex: number }
>;

export interface ResumeRecovery {
  /**
   * Arm a post-sync re-application for an element's per-element op. Call when an
   * element is first seen after the resume batch has cleared (the coordinator is
   * no longer awaiting sync) so its inline op write may have ridden on a reverted
   * reconcile. A no-op when the element already holds a value once the space
   * syncs, and at most one recovery is in flight per element key.
   *
   * `buildRunInput` is called with the element's CURRENT index at recovery time
   * (from the element-runs entry the coordinator keeps up to date), not the
   * index the element had when the recovery was armed — so an index-dependent op
   * whose element was reordered while the space was still syncing recovers with
   * the position it now holds.
   */
  schedule(
    elementKey: string,
    resultCell: Cell<any>,
    opPattern: Pattern,
    buildRunInput: (index: number) => Record<string, unknown>,
  ): void;
}

/**
 * Shared post-sync recovery for the list builtins (filter, map, flatMap).
 *
 * On a resume reconcile the coordinator reads the sibling element result cells,
 * which are still streaming in from storage on catching-up ids, so its commit is
 * preempted and every write in that transaction is reverted — including the
 * inline op instantiation for an element first seen during the resume window. An
 * element present in the durable aggregate recovers from its persisted result
 * doc; a freshly appended element has no such doc, so its value is lost with
 * nothing to re-trigger it (the per-element op may compile to a pure projection
 * with no standing action of its own). Once the space has synced, re-run the op
 * in a fresh transaction whose reads no longer land on catching-up ids, so the
 * write commits and sticks.
 */
export function createResumeRecovery(opts: {
  runtime: Runtime;
  space: MemorySpace;
  elementRuns: ElementRuns;
  logger: Logger;
}): ResumeRecovery {
  const { runtime, space, elementRuns, logger } = opts;
  const recovering = new Set<string>();
  return {
    schedule(elementKey, resultCell, opPattern, buildRunInput) {
      if (recovering.has(elementKey)) return;
      const provider = runtime.storageManager.open(space);
      const synced = provider?.synced?.bind(provider);
      if (!synced) return;
      recovering.add(elementKey);

      // Wait for the space to settle (an event, not a poll), then re-run the op
      // in a fresh transaction if the result cell is still empty. `editWithRetry`
      // rebases the write on the latest confirmed state and retries the commit
      // itself, so a fresh transaction here observes the synced basis.
      runtime.storageManager.trackUntilSettled(
        Promise.resolve(synced())
          .then(() =>
            runtime.editWithRetry((recoverTx) => {
              const entry = elementRuns.get(elementKey);
              // Superseded by a fresh run for this key — nothing to re-apply.
              if (!entry || entry.resultCell !== resultCell) return;
              // The reverted write left the result cell empty; a recovered value
              // (durable doc, or an earlier recovery) means there is nothing to
              // re-apply.
              if (resultCell.withTx(recoverTx).getRaw() !== undefined) return;
              runtime.runner.run(
                recoverTx,
                opPattern,
                buildRunInput(entry.lastIndex),
                resultCell,
                {
                  doNotUpdateOnPatternChange: true,
                  awaitSyncBeforeInitialRun: false,
                },
              );
            }).then(({ error }) => {
              if (error) {
                logger.warn(
                  "resume-recover",
                  "re-applying an appended element failed",
                  { error },
                );
              }
            })
          )
          .catch((error) =>
            logger.warn(
              "resume-recover",
              "awaiting sync to recover an appended element failed",
              { error },
            )
          )
          .finally(() => recovering.delete(elementKey)),
      );
    },
  };
}
