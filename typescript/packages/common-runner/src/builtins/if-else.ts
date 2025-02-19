import { type DocImpl, getDoc } from "../doc.js";
import { type Action } from "../scheduler.js";
import { type ReactivityLog } from "../scheduler.js";
import { getDocLinkOrThrow } from "../query-result-proxy.js";
export function ifElse(
  inputsCell: DocImpl<[any, any, any]>,
  sendResult: (result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: DocImpl<any>[],
): Action {
  const result = getDoc<any>(undefined);
  result.generateEntityId({ ifElse: cause });
  sendResult(result);

  return (log: ReactivityLog) => {
    const condition = inputsCell.getAsQueryResult([0], log);

    const ref = getDocLinkOrThrow(inputsCell.getAsQueryResult([condition ? 1 : 2], log));
    result.send(ref.cell.getAtPath(ref.path), log);
  };
}
