import { type DocImpl, getDoc } from "../doc.ts";
import { isCellLink } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type ReactivityLog } from "../scheduler.ts";
import { getCellLinkOrValue } from "../query-result-proxy.ts";

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

    const current = getCellLinkOrValue(
      inputsCell.getAsQueryResult([condition ? 1 : 2], log),
    );
    const value = isCellLink(current)
      ? current.cell.getAtPath(current.path)
      : current;
    result.send(value, log);
  };
}
