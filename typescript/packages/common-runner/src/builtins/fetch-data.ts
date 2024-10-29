import { cell, CellImpl, ReactivityLog } from "../cell.js";
import { normalizeToCells } from "../utils.js";
import { type Action } from "../scheduler.js";
/**
 * Fetch data from a URL.
 *
 * Returns the fetched result as `result`. `pending` is true while a request is pending.
 *
 * @param url - A cell containing the URL to fetch data from.
 * @param mode - The mode to use for fetching data. Either `text` or `json`
 *   default to `json` results.
 * @returns { pending: boolean, result: any, error: any } - As individual cells, representing `pending` state, final `result`, and any `error`.
 */
export function fetchData(
  inputsCell: CellImpl<{
    url: string;
    mode?: "text" | "json";
    options?: { body?: any; method?: string; headers?: Record<string, string> };
    result?: any;
  }>,
  sendResult: (result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: CellImpl<any>[]
): Action {
  const pending = cell(false);
  const result = cell<any | undefined>(undefined);
  const error = cell<any | undefined>(undefined);

  // Generate causal IDs for the cells.
  pending.generateEntityId({ fetchData: { pending: cause } });
  result.generateEntityId({ fetchData: { result: cause } });
  error.generateEntityId({ fetchData: { error: cause } });

  const resultCell = cell({
    pending,
    result,
    error,
  });

  sendResult(resultCell);

  let currentRun = 0;

  return (log: ReactivityLog) => {
    const { url, mode, options } = inputsCell.getAsQueryResult([], log);
    const processResponse =
      (mode || "json") === "json"
        ? (r: Response) => r.json()
        : (r: Response) => r.text();

    if (url === undefined) {
      pending.setAtPath([], false, log);
      result.setAtPath([], undefined, log);
      error.setAtPath([], undefined, log);
      ++currentRun;
      return;
    }

    pending.setAtPath([], true, log);
    result.setAtPath([], undefined, log);
    error.setAtPath([], undefined, log);

    const thisRun = ++currentRun;

    fetch(url, options)
      .then(processResponse)
      .then((data) => {
        if (thisRun !== currentRun) return;

        normalizeToCells(data, undefined, log, url);

        pending.setAtPath([], false, log);
        result.setAtPath([], data, log);
      })
      .catch((err) => {
        if (thisRun !== currentRun) return;

        pending.setAtPath([], false, log);
        error.setAtPath([], err, log);
      });
  };
}
