import { type Cell, createCell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type RawBuiltinResult } from "../module.ts";
import { type Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

export function navigateTo(
  inputsCell: Cell<any>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): RawBuiltinResult {
  let isInitialized = false;
  let navigated = false;
  let navigationAttempt = 0;
  let resultCell: Cell<boolean>;
  const targetCellSchema = {
    type: "object",
    properties: {},
    asCell: ["cell"],
  } as const;

  const action: Action = (tx: IExtendedStorageTransaction) => {
    // The main reason we might be called again after navigating is that the
    // transaction to update the result cell failed, so we'll just set it again.
    if (navigated) {
      resultCell?.withTx(tx).set(true);
      return;
    }

    // Initialize the result cell if it hasn't been initialized yet.
    if (!isInitialized) {
      const baseResultCell = runtime.getCell<any>(
        parentCell.space,
        { navigateTo: { result: cause } },
        { type: "boolean" },
        tx,
      );
      resultCell = createCell(
        runtime,
        {
          ...baseResultCell.getAsNormalizedFullLink(),
          scope: "session",
        },
        tx,
      );

      resultCell.sync();

      sendResult(tx, resultCell);

      isInitialized = true;
    }

    // If the result cell is already true, we've already navigated.
    if (resultCell.withTx(tx).get()) return;

    // Read with a schema that won't subscribe to the whole piece
    const inputsWithLog = inputsCell.asSchema(targetCellSchema).withTx(tx);
    const target = inputsWithLog.get();

    // Pattern creation can yield a navigable cell before every reactive
    // dependency has materialized its value. The cell identity is enough for
    // navigation; requiring a current value can block valid piece targets.
    if (target) {
      if (!runtime.navigateCallback) {
        throw new Error("navigateCallback is not set");
      }

      // Resolve to root piece - follows links until path is empty
      const resolvedTarget = target.resolveAsCell();
      const navigateCallback = runtime.navigateCallback;

      const previousNavigated = navigated;
      const thisAttempt = ++navigationAttempt;
      navigated = true;
      tx.addCommitCallback((_committedTx, commitResult) => {
        if (commitResult.error && navigationAttempt === thisAttempt) {
          navigated = previousNavigated;
        }
      });
      // Navigation is an external effect: release it only after a successful
      // commit. The outbox promise is tracked explicitly so runtime.settled()
      // cannot race async shell navigation.
      const targetLink = resolvedTarget.getAsNormalizedFullLink();
      tx.enqueuePostCommitEffect({
        // The outbox deduplicates by id within a transaction. Encode the full
        // normalized link as a tuple so scoped targets remain distinct and path
        // segments containing separators cannot collide.
        id: `navigateTo:${
          JSON.stringify([
            targetLink.space,
            targetLink.scope,
            targetLink.id,
            targetLink.path,
          ])
        }`,
        kind: "navigateTo",
        flush: async () => {
          if (navigationAttempt !== thisAttempt) return;
          const work = Promise.resolve().then(() =>
            navigateCallback(resolvedTarget)
          );
          runtime.trackAsyncWork(work);
          try {
            await work;
          } catch (error) {
            console.error("navigateTo callback failed:", error);
          }
        },
      });
      resultCell.withTx(tx).set(true);
      runtime.scheduler.queueExecution();
    }
  };

  return {
    action,
    isEffect: true,
    useDeclaredReadsAsDependencies: true,
  };
}
