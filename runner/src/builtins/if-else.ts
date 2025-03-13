import { type DocImpl, getDoc } from "../doc.ts";
import { type Action } from "../scheduler.ts";
import { type ReactivityLog } from "../scheduler.ts";
import { getCellLinkOrThrow } from "../query-result-proxy.ts";
export function ifElse(
  inputsCell: DocImpl<[any, any, any]>,
  sendResult: (result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: DocImpl<any>[],
  parentDoc: DocImpl<any>,
): Action {
  const result = getDoc<any>(undefined, { ifElse: cause }, parentDoc.space);
  sendResult(result);

  return (log: ReactivityLog) => {
    const condition = inputsCell.getAsQueryResult([0], log);

    const ref = getCellLinkOrThrow(
      inputsCell.getAsQueryResult([condition ? 1 : 2], log),
    );
    result.send(ref.cell.getAtPath(ref.path), log);
  };
}
