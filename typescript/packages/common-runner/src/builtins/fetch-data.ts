import { cell, CellImpl, ReactivityLog } from "../cell.js";
import { normalizeToCells } from "../utils.js";
import { type Action } from "../scheduler.js";
import { refer } from "merkle-reference";

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
  cause: CellImpl<any>[],
): Action {
  const pending = cell(false, { fetchData: { pending: cause } });
  const result = cell<any | undefined>(undefined, {
    fetchData: { result: cause },
  });
  const error = cell<any | undefined>(undefined, {
    fetchData: { error: cause },
  });
  const requestHash = cell<string | undefined>(undefined, {
    fetchData: { requestHash: cause },
  });

  sendResult({
    pending,
    result,
    error,
    requestHash,
  });

  let currentRun = 0;
  let previousCallHash: string | undefined = undefined;

  return (log: ReactivityLog) => {
    const { url, mode, options } = inputsCell.getAsQueryResult([], log);

    const hash = refer({
      url: url ?? "",
      mode: mode ?? "json",
      options: options ?? {},
    }).toString();

    if (hash === previousCallHash || hash === requestHash.get()) return;
    previousCallHash = hash;

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
        requestHash.setAtPath([], hash, log);
      })
      .catch((err) => {
        if (thisRun !== currentRun) return;

        pending.setAtPath([], false, log);
        error.setAtPath([], err, log);

        // TODO: Not writing now, so we retry the request after failure. Replace
        // this with more fine-grained retry logic.
        // requestHash.setAtPath([], hash, log);
      });
  };
}
