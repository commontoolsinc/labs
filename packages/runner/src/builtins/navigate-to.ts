import { type Cell, isCell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type IRuntime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { getCellOrThrow } from "../query-result-proxy.ts";

export function navigateTo(
  inputsCell: Cell<any>,
  _sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  _cause: Cell<any>[],
  _parentCell: Cell<any>,
  runtime: IRuntime,
): Action {
  return (tx: IExtendedStorageTransaction) => {
    const inputsWithLog = inputsCell.asSchema({ asCell: true }).withTx(tx);

    const target = inputsWithLog.get();

    if (!runtime.navigateCallback) {
      throw new Error("navigateCallback is not set");
    }

    if (isCell(target)) {
      if (target && target.get()) {
        runtime.navigateCallback(target);
      }
    } else {
      const sourceCell = getCellOrThrow(target);
      runtime.navigateCallback(sourceCell);
    }
  };
}
