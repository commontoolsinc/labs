import { type DocImpl, getDoc } from "../doc.ts";
import { type Action } from "../scheduler.ts";
import { type ReactivityLog } from "../scheduler.ts";

export function ifElse(
  inputsDoc: DocImpl<[any, any, any]>,
  sendResult: (result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: DocImpl<any>[],
  parentDoc: DocImpl<any>,
): Action {
  const result = getDoc<any>(undefined, { ifElse: cause }, parentDoc.space);
  sendResult(result);

  const inputsCell = inputsDoc.asCell();
  return (log: ReactivityLog) => {
    const condition = inputsCell.withLog(log).key(0).get();

    const ref = inputsCell.withLog(log).key(condition ? 1 : 2)
      .getAsCellLink();

    result.send(ref, log);
  };
}
