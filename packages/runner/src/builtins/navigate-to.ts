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

  return async (tx: IExtendedStorageTransaction) => {
    console.log("[navigateTo] Action triggered");
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
    console.log("[navigateTo] target:", target);
    const targetValue = target?.asSchema({ not: true }).get();
    console.log("[navigateTo] target value:", targetValue);
    if (target && targetValue) {
      if (!runtime.navigateCallback) {
        throw new Error("navigateCallback is not set");
      }

      // Resolve to root charm - follows links until path is empty
      const resolvedTarget = target.resolveAsCell();
      console.log(
        "[navigateTo] Navigating to resolved target:",
        resolvedTarget.getAsNormalizedFullLink(),
      );

      // Sync the target cell to ensure data is loaded before navigation
      await resolvedTarget.sync();
      console.log("[navigateTo] Target synced, now navigating");

      runtime.navigateCallback(resolvedTarget);

      navigated = true;
      resultCell.set(true);
    } else {
      console.log(
        "[navigateTo] No target or target value is undefined, not navigating",
      );
    }
  };
}
