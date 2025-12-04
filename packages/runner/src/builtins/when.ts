import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type IRuntime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

/**
 * when(condition, value) - && semantics
 * Returns value if condition is truthy, otherwise returns condition (falsy value)
 */
export function when(
  inputsCell: Cell<{ condition: any; value: any }>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: IRuntime,
): Action {
  return (tx: IExtendedStorageTransaction) => {
    const result = runtime.getCell<any>(
      parentCell.space,
      { when: cause },
      undefined,
      tx,
    );
    sendResult(tx, result);
    const resultWithLog = result.withTx(tx);
    const inputsWithLog = inputsCell.withTx(tx);

    const condition = inputsWithLog.key("condition").get();

    // && semantics: if truthy, return value; if falsy, return condition
    const ref = condition
      ? inputsWithLog.key("value").getAsLink({ base: result })
      : inputsWithLog.key("condition").getAsLink({ base: result });

    resultWithLog.setRaw(ref);
  };
}
