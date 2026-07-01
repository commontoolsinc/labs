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
import { validateAgainstSchema } from "../cfc/schema-sanitization.ts";
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
      throw new Error(`fetchJson result failed schema validation: ${failure}`);
    }
  }
  return data;
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

const asTypeArray = (type: unknown): string[] =>
  typeof type === "string" ? [type] : Array.isArray(type) ? type : [];

/**
 * Returns a copy of `schema` with `additionalProperties: true` on every
 * object-shaped subschema that doesn't declare it. validateAgainstSchema
 * treats such schemas as closed (a CFC-sanitization rule); fetch
 * verification follows standard JSON Schema semantics, where unknown object
 * properties are allowed unless the schema names `additionalProperties`.
 */
function schemaWithOpenObjects(schema: JSONSchema): JSONSchema {
  if (typeof schema === "boolean") return schema;
  const result: Record<string, unknown> = { ...schema };

  for (const key of ["not", "additionalProperties"]) {
    if (typeof result[key] === "object" && result[key] !== null) {
      result[key] = schemaWithOpenObjects(result[key] as JSONSchema);
    }
  }
  if (Array.isArray(result.items)) {
    result.items = result.items.map((item) =>
      schemaWithOpenObjects(item as JSONSchema)
    );
  } else if (typeof result.items === "object" && result.items !== null) {
    result.items = schemaWithOpenObjects(result.items as JSONSchema);
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    if (Array.isArray(result[key])) {
      result[key] = (result[key] as JSONSchema[]).map((branch) =>
        schemaWithOpenObjects(branch)
      );
    }
  }
  for (const key of ["properties", "$defs"]) {
    if (typeof result[key] === "object" && result[key] !== null) {
      result[key] = Object.fromEntries(
        Object.entries(result[key] as Record<string, JSONSchema>).map((
          [name, child],
        ) => [name, schemaWithOpenObjects(child)]),
      );
    }
  }

  const declaresObjectShape = asTypeArray(result.type).includes("object") ||
    result.properties !== undefined ||
    result.required !== undefined;
  if (declaresObjectShape && result.additionalProperties === undefined) {
    result.additionalProperties = true;
  }
  return result as JSONSchema;
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
 * Returns the fetched result as `result`. `pending` is true while a request
 * is pending; failures (including fetchJson schema verification failures)
 * land on `error`.
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
      const inputsSnapshot = snapshotInputs(inputsCell.withTx(tx));
      const mutexTimeoutMs = mutexTimeoutForCell(kind, inputsCell.withTx(tx));
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
          kind.name,
          `${kind.name}:${newRequestId}`,
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

                // Clear any previous result/error when starting a new fetch
                // This ensures observers see a clean pending state
                runtime.editWithRetry((tx) => {
                  result.withTx(tx).set(undefined);
                  error.withTx(tx).set(undefined);
                });

                // Check if URL became empty while waiting for mutex
                if (!inputsSnapshot.url) {
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
                  kind,
                  snapshotInputs,
                  inputsCell,
                  inputsSnapshot,
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
      snapshotInputs,
    );
  } catch (err) {
    // Don't write errors if request was aborted
    if (abortSignal.aborted) return;

    await runtime.idle();

    // Write error - but only update inputHash if inputs haven't changed
    await runtime.editWithRetry((tx) => {
      const currentHash = computeInputHashFromValue(
        snapshotInputs(inputsCell.withTx(tx)),
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

/**
 * Fetch binary data from a URL.
 *
 * Returns the response body as `result`, shaped `{ bytes, mediaType }` where
 * `bytes` is a FabricBytes byte buffer. `pending` is true while a request is
 * pending; failures land on `error`.
 */
export const fetchBinary = fetchBuiltin(fetchBinaryKind);

/**
 * Fetch text from a URL.
 *
 * Returns the response body decoded as UTF-8 text as `result`. `pending` is
 * true while a request is pending; failures land on `error`.
 */
export const fetchText = fetchBuiltin(fetchTextKind);

/**
 * Fetch JSON from a URL.
 *
 * Returns the parsed response body as `result`. When a `schema` input is
 * present, the parsed body is verified against it at fetch time; a
 * verification failure lands on `error` and `result` stays undefined.
 * Verification follows standard JSON Schema semantics for object
 * properties not named in the schema (allowed unless the schema declares
 * `additionalProperties`). `pending` is true while a request is pending.
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
