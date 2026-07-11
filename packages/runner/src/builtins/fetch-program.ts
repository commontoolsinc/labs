import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { CellScope } from "../builder/types.ts";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import {
  CODEC,
  CODEC_TYPE_TAGS,
  EmptyReconstructionContext,
} from "@commonfabric/data-model/codec-common";
import type { FabricValue } from "@commonfabric/data-model/interface";
import { HttpProgramResolver } from "@commonfabric/js-compiler/program";
import { ensureCompilerStack } from "../harness/deferred-compiler-stack.ts";
import { createFrozenRequestSnapshot } from "../cfc/request-snapshot.ts";
import { enqueueSinkRequestPostCommitEffect } from "../cfc/sink-request.ts";
import {
  computeInputHashFromValue,
  liveFetchInputsMatch,
  selectUnavailableFetchInput,
  writeUnavailableFetchResult,
} from "./fetch-utils.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";
import { scopedCell } from "./scope-policy.ts";
import {
  DataUnavailable,
  FabricError,
  isDataUnavailable,
} from "@commonfabric/data-model/fabric-instances";

const PROGRAM_REQUEST_TIMEOUT = 1000 * 10; // 10 seconds for program resolution

export interface ProgramResult {
  files: Array<{ name: string; contents: string }>;
  main: string;
}

type FetchErrorState = Record<string, FabricValue> & {
  type: string;
  name: string | null;
  message: string;
  stack?: string;
  cause?: FabricValue;
};

// State machine for fetch lifecycle
type FetchState =
  | { type: "idle" }
  | { type: "fetching"; requestId: string; startTime: number }
  | { type: "success"; data: ProgramResult }
  | {
    type: "error";
    error: FetchErrorState;
  };

function encodeFetchError(error: FabricError): FetchErrorState {
  return FabricError[CODEC].encode(error) as FetchErrorState;
}

function decodeFetchError(state: FetchErrorState): FabricError {
  const decoded = FabricError[CODEC].decode(
    CODEC_TYPE_TAGS.Error,
    state,
    new EmptyReconstructionContext(
      true,
      "fetchProgram durable error cache",
    ),
  );
  if (!(decoded instanceof FabricError)) {
    throw new TypeError("Invalid FabricError in fetchProgram cache");
  }
  return decoded;
}

// Single source of truth for fetch status
interface FetchCacheEntry {
  inputHash: string;
  state: FetchState;
}

const fetchProgramInputSchema = internSchema(
  {
    type: "object",
    properties: {
      url: { type: "string" },
    },
  },
);

function snapshotFetchProgramInputs(
  cell: Cell<{ url?: string; result?: ProgramResult }>,
): { url?: string } {
  const snapshot = cell.asSchema(fetchProgramInputSchema).get() ??
    ({} as { url?: string });
  return createFrozenRequestSnapshot({ url: snapshot.url });
}

function fetchProgramInputsMatchInTx(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  inputsCell: Cell<{ url: string; result?: ProgramResult }>,
  expectedInputHash: string,
): boolean {
  const unavailable = selectUnavailableFetchInput(
    inputsCell.withTx(tx).getRaw(),
    { runtime, tx, base: inputsCell },
  );
  return unavailable === undefined &&
    computeInputHashFromValue(
        snapshotFetchProgramInputs(inputsCell.withTx(tx)),
      ) === expectedInputHash;
}

// Full schema for cache structure to ensure proper validation when reading back
// from storage. Without this, nested arrays may have undefined elements due to
// incomplete schema-based transformation.
const cacheSchema = internSchema(
  {
    type: "object",
    default: {},
    additionalProperties: {
      type: "object",
      properties: {
        inputHash: { type: "string" },
        state: {
          anyOf: [
            { type: "object", properties: { type: { const: "idle" } } },
            {
              type: "object",
              properties: {
                type: { const: "fetching" },
                requestId: { type: "string" },
                startTime: { type: "number" },
              },
            },
            {
              type: "object",
              properties: {
                type: { const: "success" },
                data: {
                  type: "object",
                  properties: {
                    files: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          contents: { type: "string" },
                        },
                        required: ["name", "contents"],
                      },
                    },
                    main: { type: "string" },
                  },
                  required: ["files", "main"],
                },
              },
            },
            {
              type: "object",
              properties: {
                type: { const: "error" },
                error: {
                  type: "object",
                  properties: {
                    type: { type: "string" },
                    name: {
                      anyOf: [{ type: "string" }, { type: "null" }],
                    },
                    message: { type: "string" },
                    stack: { type: "string" },
                    cause: true,
                  },
                  required: ["type", "name", "message"],
                  additionalProperties: true,
                },
              },
              required: ["type", "error"],
            },
          ],
        },
      },
    },
  },
);

/**
 * Fetch and resolve a program from a URL.
 *
 * The internal node retains pending/error sibling cells while the builder
 * projects its result child. That child is the resolved `{ files, main }`
 * program when usable and a DataUnavailable marker otherwise.
 *
 * @param url - A cell containing the URL to fetch the program from.
 * @returns Internal compatibility state whose result child is public.
 */
export function fetchProgram(
  inputsCell: Cell<{ url: string; result?: ProgramResult }>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  let cellsInitialized = false;
  let pending: Cell<boolean>;
  let result: Cell<ProgramResult | DataUnavailable>;
  let error: Cell<any | undefined>;
  let cache: Cell<Record<string, FetchCacheEntry>>;
  let cellScope: CellScope | undefined;
  let myRequestId: string | undefined = undefined;
  let myInputHash: string | undefined = undefined;
  let abortController: AbortController | undefined = undefined;
  let cancelClaimRetry: (() => void) | undefined;

  const clearClaimRetry = (): void => {
    cancelClaimRetry?.();
    cancelClaimRetry = undefined;
  };

  const scheduleClaimRetry = (
    inputHash: string,
    requestId: string,
    startTime: number,
  ): void => {
    clearClaimRetry();
    cancelClaimRetry = scheduleFetchProgramClaimRetry(
      runtime,
      cache,
      inputHash,
      requestId,
      startTime,
    );
  };

  const releaseOwnedRequest = (
    tx: IExtendedStorageTransaction,
    reason: string,
  ): void => {
    clearClaimRetry();
    const requestId = myRequestId;
    const inputHash = myInputHash;
    if (requestId === undefined || inputHash === undefined) return;

    abortController?.abort(reason);
    const entry = cache.withTx(tx).get()[inputHash];
    if (
      entry?.state.type === "fetching" &&
      entry.state.requestId === requestId
    ) {
      cache.withTx(tx).update({
        [inputHash]: {
          inputHash,
          state: { type: "idle" },
        },
      });
    }
    abortController = undefined;
    myRequestId = undefined;
    myInputHash = undefined;
  };

  // This is called when the pattern containing this node is being stopped.
  addCancel(() => {
    clearClaimRetry();
    // Abort the request if it's still pending.
    abortController?.abort("Pattern stopped");

    // Only try to update state if cells were initialized
    if (!cellsInitialized || !myRequestId) return;

    const tx = runtime.edit();

    try {
      // If we were fetching, transition back to idle
      const currentCache = cache.withTx(tx).get();
      const updates: Record<string, FetchCacheEntry> = {};

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
    const requestSnapshot = unavailableInput === undefined
      ? snapshotFetchProgramInputs(inputsCell.withTx(tx))
      : undefined;
    const outputScope = tx.getNarrowestReadScope();

    if (!cellsInitialized || cellScope !== outputScope) {
      const basePending = runtime.getCell<boolean>(
        parentCell.space,
        { fetchProgram: { pending: cause } },
        undefined,
        tx,
      );
      pending = scopedCell(runtime, tx, basePending, outputScope);

      const baseResult = runtime.getCell<ProgramResult | DataUnavailable>(
        parentCell.space,
        {
          fetchProgram: { result: cause },
        },
        undefined,
        tx,
      );
      result = scopedCell(runtime, tx, baseResult, outputScope);

      const baseError = runtime.getCell<any | undefined>(
        parentCell.space,
        {
          fetchProgram: { error: cause },
        },
        undefined,
        tx,
      );
      error = scopedCell(runtime, tx, baseError, outputScope);

      const baseCache = runtime.getCell(
        parentCell.space,
        { fetchProgram: { cache: cause } },
        cacheSchema,
        tx,
      ) as Cell<Record<string, FetchCacheEntry>>;
      cache = scopedCell(
        runtime,
        tx,
        baseCache,
        outputScope,
      ) as Cell<Record<string, FetchCacheEntry>>;

      // Link the new result cells to the parent result cell
      setResultCell(pending, parentCell);
      setResultCell(result, parentCell);
      setResultCell(error, parentCell);
      setResultCell(cache, parentCell);
      // Link the new result cells to the pattern cell too
      const patternCellPtr = parentCell.key("pattern");
      setPatternCell(pending, patternCellPtr);
      setPatternCell(result, patternCellPtr);
      setPatternCell(error, patternCellPtr);
      setPatternCell(cache, patternCellPtr);

      // Kick off sync in the background
      pending.sync();
      result.sync();
      error.sync();
      cache.sync();

      cellsInitialized = true;
      cellScope = outputScope;
    }

    if (unavailableInput !== undefined) {
      clearClaimRetry();
      releaseOwnedRequest(tx, "Inputs unavailable");
      writeUnavailableFetchResult(
        tx,
        pending,
        result,
        error,
        unavailableInput,
      );
      sendResult(tx, { pending, result, error });
      return;
    }

    const { url } = requestSnapshot!;
    const inputHash = computeInputHashFromValue(requestSnapshot);

    if (!url) {
      clearClaimRetry();
      releaseOwnedRequest(tx, "URL unavailable");
      // An authored empty URL is locally complete but invalid.
      pending.withTx(tx).set(false);
      result.withTx(tx).setRaw(DataUnavailable.schemaMismatch());
      error.withTx(tx).set(undefined);
      sendResult(tx, { pending, result, error });
      return;
    }

    if (myRequestId !== undefined && myInputHash !== inputHash) {
      releaseOwnedRequest(tx, "Inputs changed");
    }

    // Get current state for this input hash
    const allEntries = cache.withTx(tx).get();
    const cacheEntry = allEntries[inputHash];
    const state: FetchState = cacheEntry?.state ?? { type: "idle" };

    // State machine transitions
    if (state.type === "idle") {
      clearClaimRetry();
      // Try to transition to fetching
      const requestId = crypto.randomUUID();
      const startTime = Date.now();
      cache.withTx(tx).update({
        [inputHash]: {
          inputHash,
          state: { type: "fetching", requestId, startTime },
        },
      });

      enqueueSinkRequestPostCommitEffect(
        tx,
        "fetchProgram",
        `fetchProgram:${inputHash}`,
        requestSnapshot,
        "fetchProgram-start",
        () => {
          // Start fetch asynchronously only after the transaction commits.
          // Tracked as async builtin work so `runtime.settled()`
          // wait for the program resolve + writeback; `idle()` does not.
          clearClaimRetry();
          myRequestId = requestId;
          myInputHash = inputHash;
          const controller = new AbortController();
          abortController = controller;
          const work = (async () => {
            if (
              (
                !liveFetchInputsMatch(
                  runtime,
                  inputsCell,
                  snapshotFetchProgramInputs,
                  inputHash,
                ) ||
                !liveFetchProgramClaimMatches(
                  runtime,
                  cache,
                  inputHash,
                  requestId,
                  startTime,
                )
              )
            ) {
              controller.abort("Inputs changed before fetch started");
              if (myRequestId === requestId) {
                myRequestId = undefined;
                myInputHash = undefined;
                abortController = undefined;
              }
              await resetFetchProgramClaim(
                runtime,
                cache,
                inputHash,
                requestId,
                startTime,
              );
              return;
            }
            await startFetch(
              runtime,
              cache,
              inputsCell,
              pending,
              result,
              error,
              inputHash,
              url,
              requestId,
              startTime,
              controller.signal,
            );
          })();
          runtime.trackAsyncWork(work);
        },
      );
    } else if (state.type === "fetching") {
      // Check for timeout
      const isTimedOut = Date.now() - state.startTime > PROGRAM_REQUEST_TIMEOUT;
      if (isTimedOut) {
        clearClaimRetry();
        if (myRequestId === state.requestId) {
          abortController?.abort("Program request timed out");
          abortController = undefined;
          myRequestId = undefined;
          myInputHash = undefined;
        }
        // Transition back to idle if timed out
        cache.withTx(tx).update({
          [inputHash]: {
            inputHash,
            state: { type: "idle" },
          },
        });
      } else if (myRequestId !== state.requestId) {
        scheduleClaimRetry(
          inputHash,
          state.requestId,
          state.startTime,
        );
      } else {
        clearClaimRetry();
      }
    } else {
      clearClaimRetry();
    }

    // Convert state machine state to output cells
    const currentEntries = cache.withTx(tx).get();
    const currentState = currentEntries[inputHash]?.state ?? {
      type: "idle",
    };
    switch (currentState.type) {
      case "success":
        pending.withTx(tx).set(false);
        result.withTx(tx).setRaw(currentState.data);
        error.withTx(tx).set(undefined);
        break;
      case "error": {
        const currentResult = result.withTx(tx).getRaw();
        const rawCachedState = cache.withTx(tx).getRaw()?.[inputHash]?.state;
        if (rawCachedState?.type !== "error") {
          throw new TypeError("Missing raw fetchProgram error cache state");
        }
        const unavailable = isDataUnavailable(currentResult) &&
            currentResult.reason === "error"
          ? currentResult
          : DataUnavailable.error(decodeFetchError(rawCachedState.error));
        writeUnavailableFetchResult(
          tx,
          pending,
          result,
          error,
          unavailable,
          unavailable.error,
        );
        break;
      }
      case "idle":
      case "fetching":
        writeUnavailableFetchResult(
          tx,
          pending,
          result,
          error,
          DataUnavailable.pending(),
        );
        break;
    }

    sendResult(tx, { pending, result, error });
  };
}

/**
 * Start fetching a program. Uses CAS to ensure only the tab that initiated
 * the fetch can write the result.
 */
async function startFetch(
  runtime: Runtime,
  cache: Cell<Record<string, FetchCacheEntry>>,
  inputsCell: Cell<{ url: string; result?: ProgramResult }>,
  pending: Cell<boolean>,
  result: Cell<ProgramResult | DataUnavailable>,
  error: Cell<any | undefined>,
  inputHash: string,
  url: string,
  requestId: string,
  startTime: number,
  abortSignal: AbortSignal,
) {
  try {
    // Create HTTP program resolver
    const resolver = new HttpProgramResolver(url);

    // Program resolution parses; load the deferred compiler stack first.
    const { resolveProgram, ts } = await ensureCompilerStack();
    if (abortSignal.aborted) return;

    // Resolve the program with all dependencies
    const program = await resolveProgram(resolver, {
      unresolvedModules: { type: "allow-all" },
      resolveUnresolvedModuleTypes: true,
      target: ts.ScriptTarget.ES2023,
    });

    // Check if aborted during resolution
    if (abortSignal.aborted) return;

    await runtime.idle();
    if (
      abortSignal.aborted ||
      !liveFetchInputsMatch(
        runtime,
        inputsCell,
        snapshotFetchProgramInputs,
        inputHash,
      )
    ) return;

    // CAS: Only write if we're still the active request
    await runtime.editWithRetry((tx) => {
      if (
        !fetchProgramInputsMatchInTx(
          runtime,
          tx,
          inputsCell,
          inputHash,
        )
      ) return;
      const allEntries = cache.withTx(tx).get();
      const entry = allEntries[inputHash];
      if (
        entry?.state.type === "fetching" &&
        entry.state.requestId === requestId &&
        entry.state.startTime === startTime
      ) {
        cache.withTx(tx).update({
          [inputHash]: {
            inputHash,
            state: {
              type: "success",
              data: { files: program.files, main: program.main },
            },
          },
        });
      }
    });
  } catch (err) {
    // Don't write errors if request was aborted
    if (abortSignal.aborted) return;

    await runtime.idle();
    if (
      abortSignal.aborted ||
      !liveFetchInputsMatch(
        runtime,
        inputsCell,
        snapshotFetchProgramInputs,
        inputHash,
      )
    ) return;

    const nativeError = err instanceof Error ? err : new Error(String(err));
    const unavailable = DataUnavailable.error(nativeError);
    const fabricError = unavailable.error;

    // CAS: Only write error if we're still the active request
    await runtime.editWithRetry((tx) => {
      if (
        !fetchProgramInputsMatchInTx(
          runtime,
          tx,
          inputsCell,
          inputHash,
        )
      ) return;
      const allEntries = cache.withTx(tx).get();
      const entry = allEntries[inputHash];
      if (
        entry?.state.type === "fetching" &&
        entry.state.requestId === requestId &&
        entry.state.startTime === startTime
      ) {
        cache.withTx(tx).update({
          [inputHash]: {
            inputHash,
            state: {
              type: "error",
              error: encodeFetchError(fabricError),
            },
          },
        });
        writeUnavailableFetchResult(
          tx,
          pending,
          result,
          error,
          unavailable,
          nativeError,
        );
      }
    });
  }
}

/** Arms lease-expiry recovery for a persisted fetchProgram claim. */
export function scheduleFetchProgramClaimRetry(
  runtime: Runtime,
  cache: Cell<Record<string, FetchCacheEntry>>,
  inputHash: string,
  requestId: string,
  startTime: number,
  timeout: number = PROGRAM_REQUEST_TIMEOUT,
): () => void {
  const delay = Math.max(0, startTime + timeout - Date.now());
  const timer = setTimeout(() => {
    void resetFetchProgramClaim(
      runtime,
      cache,
      inputHash,
      requestId,
      startTime,
    ).catch(() => {
      // Runtime shutdown or a conflicting owner will reconcile separately.
    });
  }, delay + 1);
  return () => clearTimeout(timer);
}

async function resetFetchProgramClaim(
  runtime: Runtime,
  cache: Cell<Record<string, FetchCacheEntry>>,
  inputHash: string,
  requestId: string,
  startTime: number,
): Promise<void> {
  await runtime.editWithRetry((tx) => {
    const entry = cache.withTx(tx).getRaw()?.[inputHash];
    if (
      entry?.state.type === "fetching" &&
      entry.state.requestId === requestId &&
      entry.state.startTime === startTime
    ) {
      cache.withTx(tx).update({
        [inputHash]: {
          inputHash,
          state: { type: "idle" },
        },
      });
    }
  });
}

function liveFetchProgramClaimMatches(
  runtime: Runtime,
  cache: Cell<Record<string, FetchCacheEntry>>,
  inputHash: string,
  requestId: string,
  startTime: number,
): boolean {
  const tx = runtime.edit();
  try {
    const entry = cache.withTx(tx).get()[inputHash];
    return entry?.state.type === "fetching" &&
      entry.state.requestId === requestId &&
      entry.state.startTime === startTime;
  } finally {
    tx.abort();
  }
}
