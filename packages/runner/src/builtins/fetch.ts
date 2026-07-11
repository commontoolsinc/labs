import type { FetchBinaryResult, JSONSchema } from "@commonfabric/api";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
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
  schemaWithOpenObjects,
  validateAgainstSchema,
} from "../cfc/schema-sanitization.ts";
import {
  isProtectedToolshedFirstPartyRoute,
  isToolshedApiOrigin,
  signFirstPartyHttpRequest,
} from "../toolshed-http-auth.ts";
import {
  computeInputHashFromValue,
  internalSchema,
  legacyFetchResultMarker,
  liveFetchClaimMatches,
  releaseFetchMutexClaim,
  REQUEST_TIMEOUT,
  scheduleFetchMutexClaimRetry,
  selectUnavailableFetchInput,
  tryClaimMutex,
  tryWriteResult,
  writeUnavailableFetchResult,
} from "./fetch-utils.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";
import { scopedCell } from "./scope-policy.ts";
import {
  DataUnavailable,
  isDataUnavailable,
} from "@commonfabric/data-model/fabric-instances";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";

type FetchRequestOptions = {
  body?: any;
  method?: string;
  headers?: Record<string, string>;
  cache?: RequestCache;
  redirect?: RequestRedirect;
  /**
   * How long (ms) a claimed request mutex stays valid before another tab may
   * take it over. Not part of the request itself: stripped before the request
   * snapshot is built so it never affects the fetch or the memoization hash.
   */
  mutexTimeoutMs?: number;
};

/** The shape of the fetch builtins' input cells (union across all kinds). */
type FetchInputs = {
  url?: string;
  /** fetchJson only. */
  schema?: JSONSchema;
  options?: FetchRequestOptions;
};

/**
 * Per-builtin descriptor. `name` keys the cause namespace for the builtin's
 * internal cells, the CFC sink name, and the post-commit effect id, so each
 * builtin has its own cell identities and sink identity. `buildRequest`
 * produces the request snapshot that is hashed for memoization and recorded
 * as the CFC sink request. `process` turns a successful response into the
 * result value (or throws).
 */
type FetchKind = {
  name:
    | "fetchBinary"
    | "fetchText"
    | "fetchJson"
    | "fetchJsonUnchecked";
  inputSchema: JSONSchema;
  buildRequest: (
    snapshot: FetchInputs,
    options: FetchRequestOptions | undefined,
  ) => FetchInputs;
  process: (response: Response, inputs: FetchInputs) => Promise<unknown>;
};

const fetchOptionsSchemaProperties = {
  body: {},
  method: { type: "string" },
  headers: {
    type: "object",
    additionalProperties: { type: "string" },
  },
  cache: { type: "string" },
  redirect: { type: "string" },
  mutexTimeoutMs: { type: "number" },
} as const;

const fetchBinaryInputSchema = internSchema(
  {
    type: "object",
    properties: {
      url: { type: "string" },
      options: { type: "object", properties: fetchOptionsSchemaProperties },
    },
  },
);

const fetchTextInputSchema = internSchema(
  {
    type: "object",
    properties: {
      url: { type: "string" },
      options: { type: "object", properties: fetchOptionsSchemaProperties },
    },
  },
);

const fetchJsonInputSchema = internSchema(
  {
    type: "object",
    properties: {
      url: { type: "string" },
      schema: {
        anyOf: [{ type: "object", additionalProperties: true }, {
          type: "boolean",
        }],
      },
      options: { type: "object", properties: fetchOptionsSchemaProperties },
    },
  },
);

const fetchJsonUncheckedInputSchema = internSchema(
  {
    type: "object",
    properties: {
      url: { type: "string" },
      options: { type: "object", properties: fetchOptionsSchemaProperties },
    },
  },
);

async function processTextResponse(response: Response): Promise<string> {
  return await response.text();
}

async function processJsonResponse(
  response: Response,
  schema?: JSONSchema,
): Promise<unknown> {
  const data = await response.json();
  if (schema !== undefined) {
    const failure = validateAgainstSchema(schemaWithOpenObjects(schema), data);
    if (failure !== undefined) {
      throw new FetchResponseSchemaMismatch(
        `fetchJson result failed schema validation: ${failure}`,
      );
    }
  }
  return data;
}

class FetchResponseSchemaMismatch extends Error {
  override readonly name = "FetchResponseSchemaMismatch";
}

async function processBinaryResponse(
  response: Response,
): Promise<FetchBinaryResult> {
  const bytes = new FabricBytes(new Uint8Array(await response.arrayBuffer()));
  const contentType = response.headers.get("content-type");
  const mediaType = contentType?.split(";")[0].trim().toLowerCase() ||
    "application/octet-stream";
  return { bytes, mediaType };
}

const fetchBinaryKind: FetchKind = {
  name: "fetchBinary",
  inputSchema: fetchBinaryInputSchema,
  buildRequest: (snapshot, options) => ({ url: snapshot.url, options }),
  process: (response) => processBinaryResponse(response),
};

const fetchTextKind: FetchKind = {
  name: "fetchText",
  inputSchema: fetchTextInputSchema,
  buildRequest: (snapshot, options) => ({ url: snapshot.url, options }),
  process: (response) => processTextResponse(response),
};

const fetchJsonKind: FetchKind = {
  name: "fetchJson",
  inputSchema: fetchJsonInputSchema,
  buildRequest: (snapshot, options) => ({
    url: snapshot.url,
    schema: snapshot.schema,
    options,
  }),
  process: (response, inputs) => processJsonResponse(response, inputs.schema),
};

const fetchJsonUncheckedKind: FetchKind = {
  name: "fetchJsonUnchecked",
  inputSchema: fetchJsonUncheckedInputSchema,
  buildRequest: (snapshot, options) => ({ url: snapshot.url, options }),
  // No schema input ever, so the body is parsed but never verified.
  process: (response) => processJsonResponse(response),
};

function snapshotInputsFor(
  kind: FetchKind,
): (cell: Cell<FetchInputs>) => FetchInputs {
  return (cell) => {
    const snapshot = cell.asSchema(kind.inputSchema).get() ??
      ({} as FetchInputs);
    // mutexTimeoutMs tunes the mutex, not the request: drop it before
    // building the snapshot so it never reaches fetch() or the input hash.
    const { mutexTimeoutMs: _mutexTimeoutMs, ...rawOptions } =
      snapshot.options ?? {};
    const body = rawOptions.body;
    const options = snapshot.options && Object.keys(rawOptions).length > 0
      ? {
        ...rawOptions,
        body: body !== undefined && typeof body !== "string"
          ? JSON.stringify(body)
          : body,
      }
      : undefined;
    return createFrozenRequestSnapshot(kind.buildRequest(snapshot, options));
  };
}

/**
 * Reads the mutex timeout (ms) from an input cell, if a positive finite value
 * is present. Returned separately from the request snapshot so it can tune the
 * cross-tab mutex without participating in request memoization.
 */
function mutexTimeoutForCell(
  kind: FetchKind,
  cell: Cell<FetchInputs>,
): number | undefined {
  const value = cell.asSchema(kind.inputSchema).get()?.options?.mutexTimeoutMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * Builds the builtin Action factory for one fetch kind. All four fetch
 * builtins share this machinery: result/pending/error/internal cells minted
 * under the builtin's cause namespace, input snapshot hashing for
 * memoization, a cross-tab mutex, abort handling, and a CFC sink request
 * enqueued per fetch.
 *
 * The internal node still publishes `{ pending, result, error }` while the
 * builder projects its `result` child as the public value. That child is the
 * fetched value when usable and a DataUnavailable marker otherwise; the
 * sibling pending/error cells remain temporarily for compatibility.
 */
function fetchBuiltin(kind: FetchKind) {
  const snapshotInputs = snapshotInputsFor(kind);

  return function (
    inputsCell: Cell<FetchInputs>,
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
    let cancelClaimRetry: (() => void) | undefined;

    const clearClaimRetry = (): void => {
      cancelClaimRetry?.();
      cancelClaimRetry = undefined;
    };

    const scheduleClaimRetry = (
      expectedInputHash: string,
      requestId: string,
      lastActivity: number,
      timeout: number,
    ): void => {
      clearClaimRetry();
      cancelClaimRetry = scheduleFetchMutexClaimRetry(
        runtime,
        inputsCell,
        snapshotInputs,
        result,
        internal,
        expectedInputHash,
        requestId,
        lastActivity,
        timeout,
      );
    };

    // This is called when the pattern containing this node is being stopped.
    addCancel(() => {
      clearClaimRetry();
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
      const unavailableInput = selectUnavailableFetchInput(
        inputsCell.withTx(tx).getRaw(),
        { runtime, tx, base: inputsCell },
      );
      const inputsSnapshot = unavailableInput === undefined
        ? snapshotInputs(inputsCell.withTx(tx))
        : undefined;
      const mutexTimeoutMs = unavailableInput === undefined
        ? mutexTimeoutForCell(kind, inputsCell.withTx(tx))
        : undefined;
      const outputScope = tx.getNarrowestReadScope();

      if (!cellsInitialized || cellScope !== outputScope) {
        const basePending = runtime.getCell<boolean>(
          parentCell.space,
          { [kind.name]: { pending: cause } },
          undefined,
          tx,
        );
        pending = scopedCell(runtime, tx, basePending, outputScope);

        const baseResult = runtime.getCell<any | undefined>(
          parentCell.space,
          {
            [kind.name]: { result: cause },
          },
          undefined,
          tx,
        );
        result = scopedCell(runtime, tx, baseResult, outputScope);

        const baseError = runtime.getCell<any | undefined>(
          parentCell.space,
          {
            [kind.name]: { error: cause },
          },
          undefined,
          tx,
        );
        error = scopedCell(runtime, tx, baseError, outputScope);

        const baseInternal = runtime.getCell(
          parentCell.space,
          { [kind.name]: { internal: cause } },
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

      if (unavailableInput !== undefined) {
        clearClaimRetry();
        abortController?.abort("Inputs unavailable");
        abortController = undefined;
        myRequestId = undefined;
        writeUnavailableFetchResult(
          tx,
          pending,
          result,
          error,
          unavailableInput,
        );
        internal.withTx(tx).set({
          requestId: "",
          lastActivity: 0,
          inputHash: "",
        });
        return;
      }

      const url = inputsSnapshot?.url;
      if (!url) {
        clearClaimRetry();
        abortController?.abort("URL unavailable");
        abortController = undefined;
        myRequestId = undefined;
        // Only update if values actually need to change to reduce transaction conflicts
        const currentPending = pending.withTx(tx).get();
        const currentResult = result.withTx(tx).getRaw();
        const currentError = error.withTx(tx).get();
        const currentInternal = internal.withTx(tx).get();

        if (currentPending !== false) pending.withTx(tx).set(false);
        if (currentResult !== DataUnavailable.schemaMismatch()) {
          result.withTx(tx).setRaw(DataUnavailable.schemaMismatch());
        }
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
      let currentResult = result.withTx(tx).getRaw();
      const currentError = error.withTx(tx).get();

      const inputsMatch = currentInternal?.inputHash === inputHash;

      // Upgrade state persisted before the direct AsyncResult cutover. Legacy
      // fetches kept pending/error only in sibling cells and left result
      // undefined; without this repair a matching terminal error never retries
      // and the public projection would remain undefined forever. Recreating a
      // pending marker also activates the normal persisted-claim lease path.
      if (inputsMatch) {
        const legacyMarker = legacyFetchResultMarker(
          currentResult,
          currentPending,
          currentError,
        );
        if (legacyMarker !== undefined) {
          result.withTx(tx).setRaw(legacyMarker);
          currentResult = legacyMarker;
        }
      }

      // If inputs changed, clear everything and abort any in-flight request
      if (!inputsMatch) {
        clearClaimRetry();
        if (myRequestId) {
          abortController?.abort("Inputs changed");
          myRequestId = undefined;
        }

        writeUnavailableFetchResult(
          tx,
          pending,
          result,
          error,
          DataUnavailable.pending(),
        );
        internal.withTx(tx).update({
          inputHash,
          requestId: "",
          lastActivity: 0,
        });
      }

      // If we have a result OR error for these inputs, we're done
      const hasValidResult = inputsMatch && currentResult !== undefined &&
        !(isDataUnavailable(currentResult) &&
          currentResult.reason === "pending");
      const hasError = inputsMatch && currentError !== undefined;

      // If we're already fetching these inputs, wait
      const alreadyFetching = inputsMatch && currentPending &&
        myRequestId !== undefined;

      const claimTimeout = mutexTimeoutMs ?? REQUEST_TIMEOUT;
      const persistedClaim = inputsMatch && currentPending &&
        myRequestId === undefined && currentInternal.requestId !== "" &&
        isDataUnavailable(currentResult) &&
        currentResult.reason === "pending";
      if (persistedClaim) {
        scheduleClaimRetry(
          inputHash,
          currentInternal.requestId,
          currentInternal.lastActivity,
          claimTimeout,
        );
      } else {
        clearClaimRetry();
      }

      // Start a new fetch if we don't have a result/error and aren't already fetching
      if (!hasValidResult && !hasError && !alreadyFetching) {
        const newRequestId = crypto.randomUUID();
        enqueueSinkRequestPostCommitEffect(
          tx,
          kind.name,
          `${kind.name}:${inputHash}`,
          inputsSnapshot,
          `${kind.name}-start`,
          () => {
            // Try to claim mutex - returns immediately if another tab is
            // processing. Tracked as async builtin work so runtime.settled()
            // waits for the fetch and its writeback; idle() does not, so the
            // post-commit handler never blocks on network I/O.
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
              snapshotInputs,
              inputHash,
              mutexTimeoutMs,
            ).then(
              async ({ claimed }) => {
                if (!claimed) {
                  // Another tab is handling this, we're done
                  return;
                }

                clearClaimRetry();
                const controller = new AbortController();
                abortController = controller;
                myRequestId = newRequestId;

                // The mutex claim atomically published pending. Revalidate at
                // the claim-to-effect hand-off so an unavailable/new input
                // committed in that window cannot launch the approved old
                // request.
                if (
                  !liveFetchClaimMatches(
                    runtime,
                    inputsCell,
                    snapshotInputs,
                    inputHash,
                    internal,
                    result,
                    newRequestId,
                  )
                ) {
                  controller.abort("Inputs changed before fetch started");
                  if (myRequestId === newRequestId) {
                    myRequestId = undefined;
                    abortController = undefined;
                  }
                  await releaseFetchMutexClaim(
                    runtime,
                    internal,
                    inputHash,
                    newRequestId,
                  );
                  return;
                }

                // Check if URL became empty while waiting for mutex
                if (!inputsSnapshot.url) {
                  // Release the lock and clear state
                  myRequestId = undefined;
                  runtime.editWithRetry((tx) => {
                    pending.withTx(tx).set(false);
                    result.withTx(tx).setRaw(
                      DataUnavailable.schemaMismatch(),
                    );
                    error.withTx(tx).set(undefined);
                    internal.withTx(tx).set({
                      requestId: "",
                      lastActivity: 0,
                      inputHash: "",
                    });
                  });
                  return;
                }

                // We claimed the mutex, start the fetch
                await startFetch(
                  runtime,
                  kind,
                  snapshotInputs,
                  inputsCell,
                  inputsSnapshot,
                  inputHash,
                  newRequestId,
                  pending,
                  result,
                  error,
                  internal,
                  controller.signal,
                );
              },
            );
            runtime.trackAsyncWork(work);
          },
        );
      }
    };
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
  kind: FetchKind,
  snapshotInputs: (cell: Cell<FetchInputs>) => FetchInputs,
  inputsCell: Cell<FetchInputs>,
  inputsSnapshot: FetchInputs,
  inputHash: string,
  requestId: string,
  pending: Cell<boolean>,
  result: Cell<any | undefined>,
  error: Cell<any | undefined>,
  internal: Cell<Schema<typeof internalSchema>>,
  abortSignal: AbortSignal,
) {
  const { url, options } = inputsSnapshot;

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
    const resolvedUrl = new URL(url!, apiBase);
    const requestOptions = await signedToolshedFetchOptions(
      runtime,
      resolvedUrl,
      apiBase,
      options,
    );
    if (abortSignal.aborted) return;
    const response = await runtime.fetch(
      resolvedUrl,
      {
        signal: abortSignal,
        ...requestOptions,
      },
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await kind.process(response, inputsSnapshot);
    if (abortSignal.aborted) return;
    await runtime.idle();
    if (abortSignal.aborted) return;

    // Try to write result - any tab can write if inputs match
    await tryWriteResult(
      runtime,
      internal,
      inputsCell,
      inputHash,
      (tx) => {
        pending.withTx(tx).set(false);
        result.withTx(tx).setRaw(data as FabricValue);
        error.withTx(tx).set(undefined);
      },
      snapshotInputs,
      requestId,
    );
  } catch (err) {
    // Don't write errors if request was aborted
    if (abortSignal.aborted) return;

    await runtime.idle();

    const unavailable = err instanceof FetchResponseSchemaMismatch
      ? DataUnavailable.schemaMismatch()
      : DataUnavailable.error(
        err instanceof Error ? err : new Error(String(err)),
      );

    // Write the failure only while this request still owns the live inputs.
    // A stale failure must not clear a newer input's pending marker.
    await tryWriteResult(
      runtime,
      internal,
      inputsCell,
      inputHash,
      (tx) => {
        writeUnavailableFetchResult(
          tx,
          pending,
          result,
          error,
          unavailable,
          err,
        );
      },
      snapshotInputs,
      requestId,
    );
  }
}

/**
 * Fetch binary data from a URL.
 *
 * The builder projects the result child as `{ bytes, mediaType }`, where
 * `bytes` is a FabricBytes byte buffer. Unavailable states are carried by the
 * same child at runtime.
 */
export const fetchBinary = fetchBuiltin(fetchBinaryKind);

/**
 * Fetch text from a URL.
 *
 * The builder projects the result child as UTF-8 text. Unavailable states are
 * carried by the same child at runtime.
 */
export const fetchText = fetchBuiltin(fetchTextKind);

/**
 * Fetch JSON from a URL.
 *
 * Returns the parsed response body. When a `schema` input is
 * present, the parsed body is verified against it at fetch time; a
 * verification failure publishes a schema-mismatch unavailable marker.
 * Verification follows standard JSON Schema semantics for object
 * properties not named in the schema (allowed unless the schema declares
 * `additionalProperties`).
 */
export const fetchJson = fetchBuiltin(fetchJsonKind);

/**
 * Fetch JSON from a URL without any schema verification.
 *
 * Like fetchJson but the parsed body is returned as-is, never verified.
 * This is the escape hatch for responses whose shape isn't declared as a
 * type; fetchJson requires an explicit type argument.
 */
export const fetchJsonUnchecked = fetchBuiltin(fetchJsonUncheckedKind);
