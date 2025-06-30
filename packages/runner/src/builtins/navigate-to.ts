import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type ReactivityLog } from "../scheduler.ts";
import { type IRuntime } from "../runtime.ts";

export function navigateTo(
  inputsCell: Cell<any>,
  _sendResult: (result: any) => void,
  _addCancel: (cancel: () => void) => void,
  _cause: Cell<any>[],
  _parentCell: Cell<any>,
  runtime: IRuntime,
): Action {
  return (log: ReactivityLog) => {
    const inputsWithLog = inputsCell.asSchema({ asCell: true }).withLog(log);

    const target = inputsWithLog.get();

    if (!runtime.navigateCallback) {
      throw new Error("navigateCallback is not set");
    }

    runtime.navigateCallback(target);
  };
}
