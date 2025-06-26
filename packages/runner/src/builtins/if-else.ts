import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type ReactivityLog } from "../scheduler.ts";
import { type IRuntime } from "../runtime.ts";

export function ifElse(
  inputsCell: Cell<[any, any, any]>,
  sendResult: (result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: IRuntime, // Runtime will be injected by the registration function
): Action {
  const result = runtime.getCell<any>(
    parentCell.getDoc().space,
    { ifElse: cause },
  );
  sendResult(result);

  return (log: ReactivityLog) => {
    const resultWithLog = result.withLog(log);
    const inputsWithLog = inputsCell.withLog(log);

    const condition = inputsWithLog.key(0).get();

    const ref = inputsWithLog.key(condition ? 1 : 2)
      .getAsLink({ base: result });

    resultWithLog.send(ref);
  };
}
