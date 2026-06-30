import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { Runtime } from "../runtime.ts";
import { getPatternEnvironment } from "../builder/env.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { Schema } from "../builder/types.ts";
import type { CellScope } from "../builder/types.ts";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { createFrozenRequestSnapshot } from "../cfc/request-snapshot.ts";
import { enqueueSinkRequestPostCommitEffect } from "../cfc/sink-request.ts";
import {
  isProtectedToolshedFirstPartyRoute,
  isToolshedApiOrigin,
  signFirstPartyHttpRequest,
} from "../toolshed-http-auth.ts";
import {
  computeInputHashFromValue,
  internalSchema,
  tryClaimMutex,
  tryWriteResult,
} from "./fetch-utils.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";
import { scopedCell } from "./scope-policy.ts";

/** The shape of fetchData's input cell. */
type FetchDataOptions = {
  body?: any;
  method?: string;
  headers?: Record<string, string>;
  mutexTimeoutMs?: number;
};

type FetchRequestOptions = Omit<FetchDataOptions, "mutexTimeoutMs">;

type FetchDataInputs = {
  url?: string;
  mode?: "text" | "json" | "dataUrl";
  options?: FetchDataOptions;
};

/**
 * Schema for fetchData inputs. Fully specifying the structure (except body,
 * which is `any`) lets cell.asSchema(schema).get() materialize nested
 * properties like options.headers as plain objects instead of proxies.
 */
const fetchDataInputSchema = internSchema(
  {
    type: "object",
    properties: {
      url: { type: "string" },
      mode: { type: "string" },
      options: {
        type: "object",
        properties: {
          body: {},
          method: { type: "string" },
          mutexTimeoutMs: { type: "number" },
          headers: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
      },
    },
  },
);

function normalizedFetchDataInputs(
  url: string | undefined,
  rawMode: string | undefined,
  rawOptions: Readonly<FetchDataOptions> | undefined,
): FetchDataInputs {
  const mode = rawMode === "text" || rawMode === "json" ||
      rawMode === "dataUrl"
    ? rawMode
    : undefined;
  const { mutexTimeoutMs: _mutexTimeoutMs, ...requestOptions } = rawOptions ??
    {};
  const body = requestOptions.body;
  const options = Object.keys(requestOptions).length > 0
    ? {
      ...requestOptions,
      body: body !== undefined && typeof body !== "string"
        ? JSON.stringify(body)
        : body,
    }
    : undefined;
  return createFrozenRequestSnapshot({ url, mode, options });
}

function snapshotFetchDataInputs(
  cell: Cell<FetchDataInputs>,
): FetchDataInputs {
  const snapshot = cell.asSchema(fetchDataInputSchema).get() ??
    ({} as FetchDataInputs);
  return normalizedFetchDataInputs(
    snapshot.url,
    snapshot.mode,
    snapshot.options,
  );
}

function snapshotFetchDataConfig(
  cell: Cell<FetchDataInputs>,
): { inputs: FetchDataInputs; mutexTimeoutMs?: number } {
  const snapshot = cell.asSchema(fetchDataInputSchema).get() ??
    ({} as FetchDataInputs);
  const mutexTimeoutMs = snapshot.options?.mutexTimeoutMs;
  return {
    inputs: normalizedFetchDataInputs(
      snapshot.url,
      snapshot.mode,
      snapshot.options,
    ),
    ...(typeof mutexTimeoutMs === "number" && Number.isFinite(mutexTimeoutMs) &&
        mutexTimeoutMs > 0
      ? { mutexTimeoutMs }
      : {}),
  };
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
  inputsCell: Cell<FetchDataInputs>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime, // Runtime will be injected by the registration function
): Action {
  let cellsInitialized = false;
  let pending: Cell<boolean>;
  let result: Cell<any | undefined>;
  let error: Cell<any | undefined>;
  let internal: Cell<Schema<typeof internalSchema>>;
  let cellScope: CellScope | undefined;
  let myRequestId: string | undefined = undefined;
  let abortController: AbortController | undefined = undefined;

  // This is called when the pattern containing this node is being stopped.
  addCancel(() => {
    // Abort the request if it's still pending.
    abortController?.abort("Pattern stopped");

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
      runtime.prepareTxForCommit(tx);
      tx.commit();
    } catch (_) {
      // Ignore errors during cleanup - the runtime might be shutting down
      tx.abort();
    }
  });

  return (tx: IExtendedStorageTransaction) => {
    tx.resetNarrowestReadScope();
    const { inputs: inputsSnapshot, mutexTimeoutMs } = snapshotFetchDataConfig(
      inputsCell.withTx(tx),
    );
    const outputScope = tx.getNarrowestReadScope();

    if (!cellsInitialized || cellScope !== outputScope) {
      const basePending = runtime.getCell<boolean>(
        parentCell.space,
        { fetchData: { pending: cause } },
        undefined,
        tx,
      );
      pending = scopedCell(runtime, tx, basePending, outputScope);

      const baseResult = runtime.getCell<any | undefined>(
        parentCell.space,
        {
          fetchData: { result: cause },
        },
        undefined,
        tx,
      );
      result = scopedCell(runtime, tx, baseResult, outputScope);

      const baseError = runtime.getCell<any | undefined>(
        parentCell.space,
        {
          fetchData: { error: cause },
        },
        undefined,
        tx,
      );
      error = scopedCell(runtime, tx, baseError, outputScope);

      const baseInternal = runtime.getCell(
        parentCell.space,
        { fetchData: { internal: cause } },
        internalSchema,
        tx,
      );
      internal = scopedCell(runtime, tx, baseInternal, outputScope);

      // Link the new result cells to the parent result cell
      setResultCell(pending, parentCell);
      setResultCell(result, parentCell);
      setResultCell(error, parentCell);
      setResultCell(internal, parentCell);
      // Link the new result cells to the pattern cell too
      const patternCellPtr = parentCell.key("pattern");
      setPatternCell(pending, patternCellPtr);
      setPatternCell(result, patternCellPtr);
      setPatternCell(error, patternCellPtr);
      setPatternCell(internal, patternCellPtr);

      // Kick off sync in the background
      pending.sync();
      result.sync();
      error.sync();
      internal.sync();

      cellsInitialized = true;
      cellScope = outputScope;
    }

    // Set results to links to our cells. We have to do this outside of
    // isInitialized since the write could conflict, and then this code will run
    // again, but isInitialized will be true already. The framework will notice
    // that this write is a no-op after the first successful write, so this
    // should be fine.
    sendResult(tx, { pending, result, error });

    const url = inputsSnapshot?.url;
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

    const inputHash = computeInputHashFromValue(inputsSnapshot);
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
      const newRequestId = inputHash;
      enqueueSinkRequestPostCommitEffect(
        tx,
        "fetchData",
        `fetchData:${newRequestId}`,
        inputsSnapshot,
        "fetchData-start",
        () => {
          // Try to claim mutex - returns immediately if another tab is processing.
          // Registered as async builtin work so `runtime.settled()`
          // wait for the fetch (and its result writeback) to land; `idle()` does
          // not, so the handler never blocks on network I/O.
          const work = tryClaimMutex(
            runtime,
            inputsCell,
            pending,
            result,
            error,
            internal,
            newRequestId,
            // Materialize inputs via the schema system and preprocess body.
            // asSchema().get() returns a frozen plain snapshot with nested
            // properties (like options.headers) fully resolved, safe to use
            // after commit.
            snapshotFetchDataInputs,
            inputHash,
            mutexTimeoutMs,
          ).then(
            async ({ claimed }) => {
              if (!claimed) {
                // Another tab is handling this, we're done
                return;
              }

              const { url, mode, options } = inputsSnapshot;

              // Clear any previous result/error when starting a new fetch
              // This ensures observers see a clean pending state
              runtime.editWithRetry((tx) => {
                result.withTx(tx).set(undefined);
                error.withTx(tx).set(undefined);
              });

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
              await startFetch(
                runtime,
                inputsCell,
                url,
                mode,
                options,
                newRequestId,
                pending,
                result,
                error,
                internal,
                abortController.signal,
              );
            },
          );
          runtime.trackAsyncWork(work);
        },
      );
    }
  };
}

function headersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

async function signedToolshedFetchOptions(
  runtime: Runtime,
  url: URL,
  apiBase: URL,
  options: FetchRequestOptions | undefined,
): Promise<FetchRequestOptions | undefined> {
  const method = options?.method ?? "GET";
  if (
    !isToolshedApiOrigin(url, apiBase) ||
    !isProtectedToolshedFirstPartyRoute(url, method)
  ) {
    return options;
  }

  const headers = await signFirstPartyHttpRequest({
    url,
    method,
    headers: options?.headers,
    body: options?.body as BodyInit | null | undefined,
    signer: runtime.storageManager.as,
  });

  return {
    ...options,
    method,
    headers: headersToRecord(headers),
  };
}

async function startFetch(
  runtime: Runtime,
  inputsCell: Cell<FetchDataInputs>,
  url: string,
  mode: "text" | "json" | "dataUrl" | undefined,
  options: FetchRequestOptions | undefined,
  inputHash: string,
  pending: Cell<boolean>,
  result: Cell<any | undefined>,
  error: Cell<any | undefined>,
  internal: Cell<Schema<typeof internalSchema>>,
  abortSignal: AbortSignal,
) {
  const processResponse = async (r: Response) => {
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}: ${r.statusText}`);
    }
    if (mode === "text") return await r.text();
    if (mode === "dataUrl") {
      const contentType = r.headers.get("content-type")?.split(";")[0]
        .trim() || "application/octet-stream";
      const bytes = new Uint8Array(await r.arrayBuffer());
      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      return `data:${contentType};base64,${btoa(binary)}`;
    }
    return await r.json();
  };

  // Body preprocessing (stringify non-string bodies) is handled by the
  // snapshotInputs callback in tryClaimMutex, so options is ready to use.
  try {
    // Relative URLs resolve against the executing space's host when the
    // space is host-mapped (federation: one runtime spans hosts). An
    // unmapped space keeps the pattern environment's api base — which on
    // some deployments (toolshed) deliberately differs from the runtime's
    // default memory host, so hostForSpace's fallback is NOT used here.
    const mappedHost = runtime.mappedHostFor(inputsCell.space);
    const apiBase = new URL(mappedHost ?? getPatternEnvironment().apiUrl);
    const resolvedUrl = new URL(url, apiBase);
    const requestOptions = await signedToolshedFetchOptions(
      runtime,
      resolvedUrl,
      apiBase,
      options,
    );
    const response = await runtime.fetch(
      resolvedUrl,
      {
        signal: abortSignal,
        ...requestOptions,
      },
    );

    const data = await processResponse(response);
    await runtime.idle();

    // Try to write result - any tab can write if inputs match
    await tryWriteResult(
      runtime,
      internal,
      inputsCell,
      inputHash,
      (tx) => {
        pending.withTx(tx).set(false);
        result.withTx(tx).set(data);
        error.withTx(tx).set(undefined);
      },
      snapshotFetchDataInputs,
    );
  } catch (err) {
    // Don't write errors if request was aborted
    if (abortSignal.aborted) return;

    await runtime.idle();

    // Write error - but only update inputHash if inputs haven't changed
    await runtime.editWithRetry((tx) => {
      const currentHash = computeInputHashFromValue(
        snapshotFetchDataInputs(inputsCell.withTx(tx)),
      );

      // Always clear pending and result
      pending.withTx(tx).set(false);
      result.withTx(tx).set(undefined);

      // Only write error and inputHash if inputs still match
      if (currentHash === inputHash) {
        error.withTx(tx).set(err);
        internal.withTx(tx).update({ inputHash });
      }
    });
  }
}
