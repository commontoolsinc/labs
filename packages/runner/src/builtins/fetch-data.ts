import { type DocImpl } from "../doc.ts";
import { type ReactivityLog } from "../scheduler.ts";
import { type Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import { refer } from "merkle-reference";

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
  inputsCell: DocImpl<{
    url: string;
    mode?: "text" | "json";
    options?: { body?: any; method?: string; headers?: Record<string, string> };
    result?: any;
  }>,
  sendResult: (result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: DocImpl<any>[],
  parentDoc: DocImpl<any>,
  runtime: IRuntime, // Runtime will be injected by the registration function
): Action {
  const pending = runtime.documentMap.getDoc(
    false,
    { fetchData: { pending: cause } },
    parentDoc.space,
  );
  const result = runtime.documentMap.getDoc<any | undefined>(
    undefined,
    {
      fetchData: { result: cause },
    },
    parentDoc.space,
  );
  const error = runtime.documentMap.getDoc<any | undefined>(
    undefined,
    {
      fetchData: { error: cause },
    },
    parentDoc.space,
  );
  const requestHash = runtime.documentMap.getDoc<string | undefined>(
    undefined,
    {
      fetchData: { requestHash: cause },
    },
    parentDoc.space,
  );

  pending.sourceCell = parentDoc;
  result.sourceCell = parentDoc;
  error.sourceCell = parentDoc;
  requestHash.sourceCell = parentDoc;

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

    const processResponse = (mode || "json") === "json"
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
      .then(async (data) => {
        if (thisRun !== currentRun) return;

        await runtime.idle();

        pending.setAtPath([], false, log);
        result.setAtPath([], data, log);
        requestHash.setAtPath([], hash, log);
      })
      .catch(async (err) => {
        if (thisRun !== currentRun) return;

        await runtime.idle();

        pending.setAtPath([], false, log);
        error.setAtPath([], err, log);

        // TODO(seefeld): Not writing now, so we retry the request after failure.
        // Replace this with more fine-grained retry logic.
        // requestHash.setAtPath([], hash, log);
      });
  };
}
