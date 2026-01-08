import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type RawBuiltinResult } from "../module.ts";
import { type Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

export function ifElse(
  inputsCell: Cell<[any, any, any]>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime, // Runtime will be injected by the registration function
): RawBuiltinResult {
  const action: Action = (tx: IExtendedStorageTransaction) => {
    const result = runtime.getCell<any>(
      parentCell.space,
      { ifElse: cause },
      undefined,
      tx,
    );
    sendResult(tx, result);
    const resultWithLog = result.withTx(tx);
    const inputsWithLog = inputsCell.withTx(tx);

    const condition = inputsWithLog.key("condition").get();

    const ref = inputsWithLog.key(condition ? "ifTrue" : "ifFalse")
      .getAsLink({ base: result });

    // When writing links, we need to use setRaw
    resultWithLog.setRaw(ref);
  };

  // Only depend on the condition for initial scheduling.
  // This way, if condition is false, we don't trigger ifTrue's computation,
  // and if condition is true, we don't trigger ifFalse's computation.
  const populateDependencies = (depTx: IExtendedStorageTransaction) => {
    inputsCell.withTx(depTx).key("condition").get();
  };

  return {
    action,
    populateDependencies,
  };
}
