import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type IRuntime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

export function ifElse(
  inputsCell: Cell<[any, any, any]>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: IRuntime, // Runtime will be injected by the registration function
): Action {
  return (tx: IExtendedStorageTransaction) => {
    const result = runtime.getCell<any>(
      parentCell.space,
      { ifElse: cause },
      undefined,
      tx,
    );
    sendResult(tx, result);
    const resultWithLog = result.withTx(tx);
    const inputsWithLog = inputsCell.withTx(tx);

    const condition = inputsWithLog.key(0).get();

    const ref = inputsWithLog.key(condition ? 1 : 2)
      .getAsLink({ base: result });

    // When writing links, we need to use setRaw
    resultWithLog.setRaw(ref);
  };
}
