import {
  cell,
  getCellReferenceOrThrow,
  type CellImpl,
  type ReactivityLog,
} from "../cell.js";
import { type Action } from "../scheduler.js";

export function ifElse(
  inputsCell: CellImpl<[any, any, any]>,
  sendResult: (result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: CellImpl<any>[]
): Action {
  const result = cell<any>(undefined);
  result.generateEntityId({ ifElse: cause });
  sendResult(result);

  return (log: ReactivityLog) => {
    const condition = inputsCell.getAsQueryResult([0], log);

    const ref = getCellReferenceOrThrow(
      inputsCell.getAsQueryResult([condition ? 1 : 2], log)
    );
    result.send(ref.cell.getAtPath(ref.path), log);
  };
}
