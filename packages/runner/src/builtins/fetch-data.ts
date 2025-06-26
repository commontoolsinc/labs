import { refer } from "merkle-reference";
import { type Cell } from "../cell.ts";
import { type ReactivityLog } from "../scheduler.ts";
import { type Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";

/**
 * Fetch data from a URL.
 *
 * Returns the fetched result as `result`. `pending` is true while a request is pending.
 *
 * @param url - A doc containing the URL to fetch data from.
 * @param mode - The mode to use for fetching data. Either `text` or `json`
 *   default to `json` results.
 * @returns { pending: boolean, result: any, error: any } - As individual docs, representing `pending` state, final `result`, and any `error`.
 */
export function fetchData(
  inputsCell: Cell<{
    url: string;
    mode?: "text" | "json";
    options?: { body?: any; method?: string; headers?: Record<string, string> };
    result?: any;
  }>,
  sendResult: (result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: IRuntime, // Runtime will be injected by the registration function
): Action {
  const pending = runtime.getCell(
    parentCell.getDoc().space,
    { fetchData: { pending: cause } },
  );
  pending.send(false);
  
  const result = runtime.getCell<any | undefined>(
    parentCell.getDoc().space,
    {
      fetchData: { result: cause },
    },
  );
  
  const error = runtime.getCell<any | undefined>(
    parentCell.getDoc().space,
    {
      fetchData: { error: cause },
    },
  );
  
  const requestHash = runtime.getCell<string | undefined>(
    parentCell.getDoc().space,
    {
      fetchData: { requestHash: cause },
    },
  );

  pending.getDoc().sourceCell = parentCell.getDoc();
  result.getDoc().sourceCell = parentCell.getDoc();
  error.getDoc().sourceCell = parentCell.getDoc();
  requestHash.getDoc().sourceCell = parentCell.getDoc();

  sendResult({
    pending,
    result,
    error,
    requestHash,
  });

  let currentRun = 0;
  let previousCallHash: string | undefined = undefined;

  return (log: ReactivityLog) => {
    const pendingWithLog = pending.withLog(log);
    const resultWithLog = result.withLog(log);
    const errorWithLog = error.withLog(log);
    const requestHashWithLog = requestHash.withLog(log);
    
    const { url, mode, options } = inputsCell.getAsQueryResult([], log);

    const hash = refer({
      url: url ?? "",
      mode: mode ?? "json",
      options: options ?? {},
    }).toString();

    if (hash === previousCallHash || hash === requestHashWithLog.get()) return;
    previousCallHash = hash;

    const processResponse = (mode || "json") === "json"
      ? (r: Response) => r.json()
      : (r: Response) => r.text();

    if (url === undefined) {
      pendingWithLog.set(false);
      resultWithLog.set(undefined);
      errorWithLog.set(undefined);
      ++currentRun;
      return;
    }

    pendingWithLog.set(true);
    resultWithLog.set(undefined);
    errorWithLog.set(undefined);

    const thisRun = ++currentRun;

    fetch(url, options)
      .then(processResponse)
      .then(async (data) => {
        if (thisRun !== currentRun) return;

        await runtime.idle();

        pendingWithLog.set(false);
        resultWithLog.set(data);
        requestHashWithLog.set(hash);
      })
      .catch(async (err) => {
        if (thisRun !== currentRun) return;

        await runtime.idle();

        pendingWithLog.set(false);
        errorWithLog.set(err);

        // TODO(seefeld): Not writing now, so we retry the request after failure.
        // Replace this with more fine-grained retry logic.
        // requestHash.setAtPath([], hash, log);
      });
  };
}
