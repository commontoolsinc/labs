import { refer } from "merkle-reference/json";
import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import { getRecipeEnvironment } from "../builder/env.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { JSONSchema, Schema } from "../builder/types.ts";

const REQUEST_TIMEOUT = 1000 * 5; // 5 seconds

const internalSchema = {
  type: "object",
  properties: {
    requestId: { type: "string" },
    lastActivity: { type: "number" },
    inputHash: { type: "string" },
  },
  required: ["requestId", "lastActivity", "inputHash"],
} as const satisfies JSONSchema;

/**
 * Computes a hash of the fetch inputs for comparison.
 */
function computeInputHash(
  url: string | undefined,
  mode: "text" | "json" | undefined,
  options:
    | { body?: any; method?: string; headers?: Record<string, string> }
    | undefined,
): string {
  return refer({
    url: url ?? "",
    mode: mode ?? "json",
    options: options ?? {},
  }).toString();
}

/**
 * Attempts to claim the mutex for a fetch request. Only claims if no other
 * request is active or if the previous request has timed out.
 *
 * @param runtime - The runtime instance
 * @param pending - Cell containing the pending state
 * @param internal - Cell containing the internal state
 * @param requestId - The request ID to claim with
 * @param inputHash - Hash of the current inputs
 * @returns true if mutex was claimed, false otherwise
 */
async function tryClaimMutex(
  runtime: IRuntime,
  pending: Cell<boolean>,
  internal: Cell<Schema<typeof internalSchema>>,
  requestId: string,
  inputHash: string,
): Promise<boolean> {
  let claimed = false;
  await runtime.editWithRetry((tx) => {
    const currentInternal = internal.withTx(tx).get();
    const isPending = pending.withTx(tx).get();
    const now = Date.now();

    // Can claim if:
    // 1. Nothing is pending, OR
    // 2. Previous request timed out, OR
    // 3. Inputs changed (different hash)
    const canClaim = !isPending ||
      (currentInternal.lastActivity < now - REQUEST_TIMEOUT) ||
      (currentInternal.inputHash !== inputHash);

    if (canClaim) {
      pending.withTx(tx).set(true);
      internal.withTx(tx).set({
        requestId,
        lastActivity: now,
        inputHash,
      });
      claimed = true;
    }
  });
  return claimed;
}

/**
 * Performs a mutation if the inputs haven't changed. This allows any tab
 * to write the result as long as the inputs are still the same.
 *
 * @param runtime - The runtime instance
 * @param internal - Cell containing the internal state
 * @param inputsCell - Cell containing the input values
 * @param expectedHash - Hash of the inputs when request started
 * @param action - The mutation action to perform
 * @returns true if the action was performed, false otherwise
 */
async function tryWriteResult(
  runtime: IRuntime,
  internal: Cell<Schema<typeof internalSchema>>,
  inputsCell: Cell<{
    url: string;
    mode?: "text" | "json";
    options?: { body?: any; method?: string; headers?: Record<string, string> };
  }>,
  expectedHash: string,
  action: (tx: IExtendedStorageTransaction) => void,
): Promise<boolean> {
  let success = false;
  await runtime.editWithRetry((tx) => {
    // Recompute the hash from current inputs within the transaction
    const { url, mode, options } = inputsCell.getAsQueryResult([], tx);
    const currentHash = computeInputHash(url, mode, options);

    // Only write if inputs haven't changed since we started the request
    if (currentHash === expectedHash) {
      action(tx);
      // Also update the internal state to reflect this hash
      internal.withTx(tx).key("inputHash").set(currentHash);
      success = true;
    }
  });
  return success;
}

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

    const tx = runtime.edit();

    // If the pending request is ours, set pending to false and clear the requestId.
    if (internal.withTx(tx).key("requestId").get() === myRequestId) {
      pending.withTx(tx).set(false);
      internal.withTx(tx).key("requestId").set("");
    }

    // Since we're aborting, don't retry. If the above fails, it's because the
    // requestId was already changing under us.
    tx.commit();
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
    sendResult(tx, {
      pending,
      result,
      error,
    });

    const { url, mode, options } = inputsCell.getAsQueryResult([], tx);
    const inputHash = computeInputHash(url, mode, options);

    if (url === undefined) {
      pending.withTx(tx).set(false);
      result.withTx(tx).set(undefined);
      error.withTx(tx).set(undefined);
      return;
    }

    // Check if inputs changed - if so, abort any in-flight request
    const currentInternal = internal.withTx(tx).get();
    if (myRequestId && currentInternal.inputHash !== inputHash) {
      abortController?.abort("Inputs changed");
      myRequestId = undefined;
    }

    // Try to start a new request
    if (!myRequestId) {
      const newRequestId = crypto.randomUUID();
      abortController = new AbortController();

      // Try to claim mutex - returns immediately if another tab is processing
      tryClaimMutex(runtime, pending, internal, newRequestId, inputHash).then(
        (claimed) => {
          if (!claimed) {
            // Another tab is handling this, we're done
            return;
          }

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
            abortController!.signal,
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

    // Try to write error - any tab can write if inputs match
    await tryWriteResult(runtime, internal, inputsCell, inputHash, (tx) => {
      pending.withTx(tx).set(false);
      result.withTx(tx).set(undefined);
      error.withTx(tx).set(err);
    });
  }
}
