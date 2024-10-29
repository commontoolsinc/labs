import {
  cell,
  getCellReferenceOrThrow,
  type CellImpl,
  type ReactivityLog,
} from "../cell.js";
import { type Action } from "../scheduler.js";

export function ifElse(
  inputsCell: CellImpl<[any, any, any]>,
  sendResult: (result: any) => void
): Action {
  const result = cell<any>(undefined);
  result.generateEntityId({ ifElse: inputsCell.get() });
  sendResult(result);

  return (log: ReactivityLog) => {
    const condition = inputsCell.getAsQueryResult([0], log);

    const ref = getCellReferenceOrThrow(
      inputsCell.getAsQueryResult([condition ? 1 : 2], log)
    );
    result.send(ref.cell.getAsQueryResult(ref.path), log);
  };
}
