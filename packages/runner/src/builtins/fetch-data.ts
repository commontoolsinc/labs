import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import { getRecipeEnvironment } from "../builder/env.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  type AsyncOperationCache,
  asyncOperationCacheSchema,
  computeInputHash,
  getState,
  isTimedOut,
  transitionToError,
  transitionToFetching,
  transitionToIdle,
  transitionToSuccess,
} from "./async-operation-state.ts";

const DATA_REQUEST_TIMEOUT = 1000 * 10; // 10 seconds for data fetching

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
  let cache: Cell<Record<string, AsyncOperationCache<any, any>>>;
  let myRequestId: string | undefined = undefined;
  let abortController: AbortController | undefined = undefined;

  // This is called when the recipe containing this node is being stopped.
  addCancel(() => {
    // Abort the request if it's still pending.
    abortController?.abort("Recipe stopped");

    // Only try to update state if cells were initialized
    if (!cellsInitialized || !myRequestId) return;

    const tx = runtime.edit();

    try {
      // If we were fetching, transition back to idle
      const currentCache = cache.withTx(tx).get();
      const updates: Record<string, AsyncOperationCache<any, any>> = {};

      for (const [hash, entry] of Object.entries(currentCache)) {
        if (
          entry.state.type === "fetching" &&
          entry.state.requestId === myRequestId
        ) {
          updates[hash] = {
            inputHash: hash,
            state: { type: "idle" },
          };
        }
      }

      if (Object.keys(updates).length > 0) {
        cache.withTx(tx).update(updates);
      }

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

      cache = runtime.getCell(
        parentCell.space,
        { fetchData: { cache: cause } },
        asyncOperationCacheSchema,
        tx,
      ) as Cell<Record<string, AsyncOperationCache<any, any>>>;

      pending.setSourceCell(parentCell);
      result.setSourceCell(parentCell);
      error.setSourceCell(parentCell);
      cache.setSourceCell(parentCell);

      // Kick off sync in the background
      pending.sync();
      result.sync();
      error.sync();
      cache.sync();

      cellsInitialized = true;
    }

    const { url } = inputsCell.getAsQueryResult([], tx);
    const inputHash = computeInputHash(tx, inputsCell);

    if (!url) {
      // When URL is empty, clear outputs
      pending.withTx(tx).set(false);
      result.withTx(tx).set(undefined);
      error.withTx(tx).set(undefined);
      sendResult(tx, { pending, result, error });
      return;
    }

    // Get current state for this input hash
    const state = getState(cache, inputHash, tx);

    // State machine transitions
    if (state.type === "idle") {
      // Try to transition to fetching (CAS - only one runtime wins)
      const requestId = crypto.randomUUID();
      const didStart = transitionToFetching(cache, inputHash, requestId, tx);

      if (didStart) {
        // We won the race - start fetch asynchronously
        myRequestId = requestId;
        abortController = new AbortController();
        startFetch(
          runtime,
          cache,
          inputHash,
          url,
          inputsCell.withTx(tx).key("mode").get(),
          inputsCell.withTx(tx).key("options").get(),
          requestId,
          abortController.signal,
        );
      }
      // else: Another runtime is already fetching, we'll see the result on next eval
    } else if (state.type === "fetching") {
      // Check for timeout
      if (isTimedOut(state, DATA_REQUEST_TIMEOUT)) {
        // Transition back to idle if timed out
        transitionToIdle(cache, inputHash, state.requestId, tx);
      }
    }

    // Convert state machine state to output cells
    const currentState = getState(cache, inputHash, tx);
    pending.withTx(tx).set(currentState.type === "fetching");
    result.withTx(tx).set(
      currentState.type === "success" ? currentState.data : undefined,
    );
    error.withTx(tx).set(
      currentState.type === "error" ? currentState.error : undefined,
    );

    sendResult(tx, { pending, result, error });
  };
}

/**
 * Start fetching data. Uses CAS to ensure only the tab that initiated
 * the fetch can write the result.
 */
async function startFetch(
  runtime: IRuntime,
  cache: Cell<Record<string, AsyncOperationCache<any, any>>>,
  inputHash: string,
  url: string,
  mode: "text" | "json" | undefined,
  options:
    | { body?: any; method?: string; headers?: Record<string, string> }
    | undefined,
  requestId: string,
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

    // Check if aborted during fetch
    if (abortSignal.aborted) return;

    await runtime.idle();

    // CAS: Only write if we're still the active request
    await transitionToSuccess(runtime, cache, inputHash, data, requestId);
  } catch (err) {
    // Don't write errors if request was aborted
    if (abortSignal.aborted) return;

    await runtime.idle();

    // CAS: Only write error if we're still the active request
    await transitionToError(
      runtime,
      cache,
      inputHash,
      err instanceof Error ? err.message : String(err),
      requestId,
    );
  }
}
