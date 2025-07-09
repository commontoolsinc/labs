import { refer } from "merkle-reference";
import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

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
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: IRuntime, // Runtime will be injected by the registration function
): Action {
  let currentRun = 0;
  let previousCallHash: string | undefined = undefined;
  let cellsInitialized = false;
  let pending: Cell<boolean>;
  let result: Cell<any | undefined>;
  let error: Cell<any | undefined>;
  let requestHash: Cell<string | undefined>;

  return (tx: IExtendedStorageTransaction) => {
    if (!cellsInitialized) {
      pending = runtime.getCell(
        parentCell.space,
        { fetchData: { pending: cause } },
        undefined,
        tx,
      );
      pending.send(false);

      result = runtime.getCell<any | undefined>(
        parentCell.space,
        {
          fetchData: { result: cause },
        },
        undefined,
        tx,
      );

      error = runtime.getCell<any | undefined>(
        parentCell.space,
        {
          fetchData: { error: cause },
        },
        undefined,
        tx,
      );

      requestHash = runtime.getCell<string | undefined>(
        parentCell.space,
        {
          fetchData: { requestHash: cause },
        },
        undefined,
        tx,
      );

      pending.setSourceCell(parentCell);
      result.setSourceCell(parentCell);
      error.setSourceCell(parentCell);
      requestHash.setSourceCell(parentCell);

      sendResult(tx, {
        pending,
        result,
        error,
        requestHash,
      });
      cellsInitialized = true;
    }
    const pendingWithLog = pending.withTx(tx);
    const resultWithLog = result.withTx(tx);
    const errorWithLog = error.withTx(tx);
    const requestHashWithLog = requestHash.withTx(tx);

    const { url, mode, options } = inputsCell.getAsQueryResult([], tx);

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
