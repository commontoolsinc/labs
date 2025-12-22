import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

export function navigateTo(
  inputsCell: Cell<any>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  let isInitialized = false;
  let navigated = false;
  let resultCell: Cell<boolean>;

  return (tx: IExtendedStorageTransaction) => {
    // The main reason we might be called again after navigating is that the
    // transaction to update the result cell failed, so we'll just set it again.
    if (navigated) {
      resultCell?.withTx(tx).set(true);
      return;
    }

    // Initialize the result cell if it hasn't been initialized yet.
    if (!isInitialized) {
      resultCell = runtime.getCell<any>(
        parentCell.space,
        { navigateTo: { result: cause } },
        { type: "boolean" },
        tx,
      );

      resultCell.sync();

      sendResult(tx, resultCell);

      isInitialized = true;
    }

    // If the result cell is already true, we've already navigated.
    if (resultCell.withTx(tx).get()) return;

    // Read with a schema that won't subscribe to the whole charm
    const inputsWithLog = inputsCell.asSchema({ not: true, asCell: true })
      .withTx(tx);
    const target = inputsWithLog.get();

    // If we have a target and the value isn't `undefined`, navigate to it.
    // TODO(seefeld): This might break once we support the not operation in
    // client-side schema validation. Then we'll need another way to check for
    // not undefined without subscribing deeper than the first level.
    if (target && target.asSchema({ not: true }).get()) {
      if (!runtime.navigateCallback) {
        throw new Error("navigateCallback is not set");
      }

      // Early exit: if already at root, navigate directly.
      // Otherwise resolve to root charm first (handles cells from wish().result
      // which have non-empty paths like ["result"]).
      const link = target.getAsNormalizedFullLink();
      const resolvedTarget = link.path.length === 0
        ? target
        : target.resolveToRoot();

      runtime.navigateCallback(resolvedTarget);

      navigated = true;
      resultCell.withTx(tx).set(true);
    }
  };
}
