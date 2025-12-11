import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

/**
 * unless(condition, fallback) - || semantics
 * Returns condition if truthy, otherwise returns fallback
 */
export function unless(
  inputsCell: Cell<{ condition: any; fallback: any }>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  return (tx: IExtendedStorageTransaction) => {
    const result = runtime.getCell<any>(
      parentCell.space,
      { unless: cause },
      undefined,
      tx,
    );
    sendResult(tx, result);
    const resultWithLog = result.withTx(tx);
    const inputsWithLog = inputsCell.withTx(tx);

    const condition = inputsWithLog.key("condition").get();

    // || semantics: if truthy, return condition; if falsy, return fallback
    const ref = condition
      ? inputsWithLog.key("condition").getAsLink({ base: result })
      : inputsWithLog.key("fallback").getAsLink({ base: result });

    resultWithLog.setRaw(ref);
  };
}
