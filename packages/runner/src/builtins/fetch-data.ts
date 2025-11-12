import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import { getRecipeEnvironment } from "../builder/env.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { Schema } from "../builder/types.ts";
import {
  computeInputHash,
  internalSchema,
  tryClaimMutex,
  tryWriteResult,
} from "./fetch-utils.ts";

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
  addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: IRuntime, // Runtime will be injected by the registration function
): Action {
  let cellsInitialized = false;
  let pending: Cell<boolean>;
  let result: Cell<any | undefined>;
  let error: Cell<any | undefined>;
  let internal: Cell<Schema<typeof internalSchema>>;
  let myRequestId: string | undefined = undefined;
  let abortController: AbortController | undefined = undefined;

  // This is called when the recipe containing this node is being stopped.
  addCancel(() => {
    // Abort the request if it's still pending.
    abortController?.abort("Recipe stopped");

    // Only try to update state if cells were initialized
    if (!cellsInitialized) return;

    const tx = runtime.edit();

    try {
      // If the pending request is ours, set pending to false and clear the requestId.
      const currentRequestId = internal.withTx(tx).key("requestId").get();
      if (currentRequestId === myRequestId) {
        pending.withTx(tx).set(false);
        internal.withTx(tx).key("requestId").set("");
      }

      // Since we're aborting, don't retry. If the above fails, it's because the
      // requestId was already changing under us.
      tx.commit();
    } catch (_) {
      // Ignore errors during cleanup - the runtime might be shutting down
      tx.abort();
    }
  });

  return (tx: IExtendedStorageTransaction) => {
    if (!cellsInitialized) {
      pending = runtime.getCell(
        parentCell.space,
        { fetchData: { pending: cause } },
        undefined,
        tx,
      );

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

      internal = runtime.getCell(
        parentCell.space,
        { fetchData: { internal: cause } },
        internalSchema,
        tx,
      );

      pending.setSourceCell(parentCell);
      result.setSourceCell(parentCell);
      error.setSourceCell(parentCell);
      internal.setSourceCell(parentCell);

      // Kick off sync in the background
      pending.sync();
      result.sync();
      error.sync();
      internal.sync();

      cellsInitialized = true;
    }

    // Set results to links to our cells. We have to do this outside of
    // isInitialized since the write could conflict, and then this code will run
    // again, but isInitialized will be true already. The framework will notice
    // that this write is a no-op after the first successful write, so this
    // should be fine.
    sendResult(tx, { pending, result, error });

    const { url } = inputsCell.getAsQueryResult([], tx);
    const inputHash = computeInputHash(tx, inputsCell);

    if (!url) {
      // Only update if values actually need to change to reduce transaction conflicts
      const currentPending = pending.withTx(tx).get();
      const currentResult = result.withTx(tx).get();
      const currentError = error.withTx(tx).get();
      const currentInternal = internal.withTx(tx).get();

      if (currentPending !== false) pending.withTx(tx).set(false);
      if (currentResult !== undefined) result.withTx(tx).set(undefined);
      if (currentError !== undefined) error.withTx(tx).set(undefined);
      // Clear internal state when URL is empty so we don't think we have cached results
      if (currentInternal.inputHash !== "") {
        internal.withTx(tx).set({
          requestId: "",
          lastActivity: 0,
          inputHash: "",
        });
      }
      return;
    }

    // Check if we're already working on or have the result for these inputs
    const currentInternal = internal.withTx(tx).get();
    const currentPending = pending.withTx(tx).get();
    const currentResult = result.withTx(tx).get();
    const currentError = error.withTx(tx).get();

    const inputsMatch = currentInternal?.inputHash === inputHash;

    // If inputs changed, clear everything and abort any in-flight request
    if (!inputsMatch) {
      if (myRequestId) {
        abortController?.abort("Inputs changed");
        myRequestId = undefined;
      }

      pending.withTx(tx).set(false);
      result.withTx(tx).set(undefined);
      error.withTx(tx).set(undefined);
      internal.withTx(tx).update({
        inputHash,
        requestId: "",
        lastActivity: 0,
      });
    }

    // If we have a result OR error for these inputs, we're done
    const hasValidResult = inputsMatch && currentResult !== undefined;
    const hasError = inputsMatch && currentError !== undefined;

    // If we're already fetching these inputs, wait
    const alreadyFetching = inputsMatch && currentPending &&
      myRequestId !== undefined;

    // Start a new fetch if we don't have a result/error and aren't already fetching
    if (!hasValidResult && !hasError && !alreadyFetching) {
      const newRequestId = crypto.randomUUID();

      // Try to claim mutex - returns immediately if another tab is processing
      tryClaimMutex(
        runtime,
        inputsCell,
        pending,
        result,
        error,
        internal,
        newRequestId,
      ).then(
        ({ claimed, inputs, inputHash }) => {
          if (!claimed) {
            // Another tab is handling this, we're done
            return;
          }

          const { url, mode, options } = inputs;

          // Check if URL became empty while waiting for mutex
          if (!url) {
            // Release the lock and clear state
            myRequestId = undefined;
            runtime.editWithRetry((tx) => {
              pending.withTx(tx).set(false);
              result.withTx(tx).set(undefined);
              error.withTx(tx).set(undefined);
              internal.withTx(tx).set({
                requestId: "",
                lastActivity: 0,
                inputHash: "",
              });
            });
            return;
          }

          abortController = new AbortController();

          // We claimed the mutex, start the fetch
          myRequestId = newRequestId;
          startFetch(
            runtime,
            inputsCell,
            url,
            mode,
            options,
            inputHash,
            pending,
            result,
            error,
            internal,
            abortController.signal,
          );
        },
      );
    }
  };
}

async function startFetch(
  runtime: IRuntime,
  inputsCell: Cell<{
    url: string;
    mode?: "text" | "json";
    options?: { body?: any; method?: string; headers?: Record<string, string> };
  }>,
  url: string,
  mode: "text" | "json" | undefined,
  options:
    | { body?: any; method?: string; headers?: Record<string, string> }
    | undefined,
  inputHash: string,
  pending: Cell<boolean>,
  result: Cell<any | undefined>,
  error: Cell<any | undefined>,
  internal: Cell<Schema<typeof internalSchema>>,
  abortSignal: AbortSignal,
) {
  const processResponse = (mode || "json") === "json"
    ? (r: Response) => r.json()
    : (r: Response) => r.text();

  const fetchOptions = { ...options };
  if (
    fetchOptions.body !== undefined && typeof fetchOptions.body !== "string"
  ) {
    fetchOptions.body = JSON.stringify(fetchOptions.body);
  }

  try {
    const response = await fetch(
      new URL(url, getRecipeEnvironment().apiUrl),
      {
        signal: abortSignal,
        ...fetchOptions,
      },
    );

    const data = await processResponse(response);
    await runtime.idle();

    // Try to write result - any tab can write if inputs match
    await tryWriteResult(runtime, internal, inputsCell, inputHash, (tx) => {
      pending.withTx(tx).set(false);
      result.withTx(tx).set(data);
      error.withTx(tx).set(undefined);
    });
  } catch (err) {
    // Don't write errors if request was aborted
    if (abortSignal.aborted) return;

    await runtime.idle();

    // Always write error and clear pending - use try/catch to ensure this completes
    try {
      await runtime.editWithRetry((tx) => {
        pending.withTx(tx).set(false);
        result.withTx(tx).set(undefined);
        error.withTx(tx).set(err);
        internal.withTx(tx).update({ inputHash });
      });
    } catch (writeErr) {
      // If we can't write the error, at least clear pending
      console.error("Failed to write error state:", writeErr);
      const tx = runtime.edit();
      try {
        pending.withTx(tx).set(false);
        tx.commit();
      } catch {
        tx.abort();
      }
    }
  }
}
