import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { CellScope } from "../builder/types.ts";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { HttpProgramResolver } from "@commonfabric/js-compiler/program";
import { ensureCompilerStack } from "../harness/deferred-compiler-stack.ts";
import { createFrozenRequestSnapshot } from "../cfc/request-snapshot.ts";
import { enqueueSinkRequestPostCommitEffect } from "../cfc/sink-request.ts";
import { computeInputHashFromValue } from "./fetch-utils.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";
import { scopedCell } from "./scope-policy.ts";
import { getPatternEnvironment } from "../builder/env.ts";
import type { NormalizedFullLink } from "../link-utils.ts";

const PROGRAM_REQUEST_TIMEOUT = 1000 * 10; // 10 seconds for program resolution

export interface ProgramResult {
  files: Array<{ name: string; contents: string }>;
  main: string;
}

// State machine for fetch lifecycle
type FetchState =
  | { type: "idle" }
  | { type: "fetching"; requestId: string; startTime: number }
  | { type: "success"; data: ProgramResult }
  | { type: "error"; message: string };

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
                message: { type: "string" },
              },
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
 * Returns the resolved program as `result` with structure { files, main }.
 * `pending` is true while resolution is in progress.
 *
 * @param url - A cell containing the URL to fetch the program from.
 * @returns { pending: boolean, result: ProgramResult, error: any } - As individual cells.
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
  let result: Cell<ProgramResult | undefined>;
  let error: Cell<any | undefined>;
  let cache: Cell<Record<string, FetchCacheEntry>>;
  let cellScope: CellScope | undefined;
  let myRequestId: string | undefined = undefined;
  let abortController: AbortController | undefined = undefined;
  const serverBuiltinRuntimeWrites: NormalizedFullLink[] = [];

  // This is called when the pattern containing this node is being stopped.
  addCancel(() => {
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

  const action: Action = (tx: IExtendedStorageTransaction) => {
    tx.resetNarrowestReadScope();
    const requestSnapshot = snapshotFetchProgramInputs(inputsCell.withTx(tx));
    const outputScope = tx.getNarrowestReadScope();

    if (!cellsInitialized || cellScope !== outputScope) {
      const basePending = runtime.getCell<boolean>(
        parentCell.space,
        { fetchProgram: { pending: cause } },
        undefined,
        tx,
      );
      pending = scopedCell(runtime, tx, basePending, outputScope);

      const baseResult = runtime.getCell<ProgramResult | undefined>(
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
    serverBuiltinRuntimeWrites.splice(
      0,
      serverBuiltinRuntimeWrites.length,
      pending.getAsNormalizedFullLink(),
      result.getAsNormalizedFullLink(),
      error.getAsNormalizedFullLink(),
      cache.getAsNormalizedFullLink(),
    );

    const { url } = requestSnapshot;
    const inputHash = computeInputHashFromValue(requestSnapshot);

    if (!url) {
      // When URL is empty, clear outputs
      pending.withTx(tx).set(false);
      result.withTx(tx).set(undefined);
      error.withTx(tx).set(undefined);
      sendResult(tx, { pending, result, error });
      return;
    }

    // Get current state for this input hash
    const allEntries = cache.withTx(tx).get();
    const cacheEntry = allEntries[inputHash];
    const state: FetchState = cacheEntry?.state ?? { type: "idle" };

    // State machine transitions
    if (state.type === "idle") {
      // Try to transition to fetching
      const requestId = inputHash;
      cache.withTx(tx).update({
        [inputHash]: {
          inputHash,
          state: { type: "fetching", requestId, startTime: Date.now() },
        },
      });

      enqueueSinkRequestPostCommitEffect(
        tx,
        "fetchProgram",
        `fetchProgram:${requestId}`,
        requestSnapshot,
        "fetchProgram-start",
        () => {
          // Start fetch asynchronously only after the transaction commits.
          // Tracked as async builtin work so `runtime.settled()`
          // wait for the program resolve + writeback; `idle()` does not.
          myRequestId = requestId;
          abortController = new AbortController();
          runtime.trackAsyncWork(
            startFetch(
              runtime,
              cache,
              inputHash,
              url,
              requestId,
              abortController.signal,
            ),
            { externalEffect: true },
          );
        },
      );
    } else if (state.type === "fetching") {
      // Check for timeout
      const isTimedOut = Date.now() - state.startTime > PROGRAM_REQUEST_TIMEOUT;
      if (isTimedOut) {
        // Transition back to idle if timed out
        cache.withTx(tx).update({
          [inputHash]: {
            inputHash,
            state: { type: "idle" },
          },
        });
      }
    }

    // Convert state machine state to output cells
    const currentEntries = cache.withTx(tx).get();
    const currentState = currentEntries[inputHash]?.state ?? {
      type: "idle",
    };
    pending.withTx(tx).set(currentState.type === "fetching");
    result.withTx(tx).set(
      currentState.type === "success" ? currentState.data : undefined,
    );
    error.withTx(tx).set(
      currentState.type === "error" ? currentState.message : undefined,
    );

    sendResult(tx, { pending, result, error });
  };
  return Object.assign(action, { serverBuiltinRuntimeWrites });
}

/**
 * Start fetching a program. Uses CAS to ensure only the tab that initiated
 * the fetch can write the result.
 */
async function startFetch(
  runtime: Runtime,
  cache: Cell<Record<string, FetchCacheEntry>>,
  inputHash: string,
  url: string,
  requestId: string,
  abortSignal: AbortSignal,
) {
  try {
    const mappedHost = runtime.mappedHostFor(cache.space);
    const apiBase = new URL(mappedHost ?? getPatternEnvironment().apiUrl);
    const resolvedMain = new URL(url, apiBase);
    const beganRelative = !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url.trim()) &&
      !/^[\\/]{2}/.test(url.trim());
    // Create HTTP program resolver
    const resolver = new HttpProgramResolver(
      resolvedMain,
      (input, init) => {
        const target = input instanceof URL ? input : new URL(
          input instanceof Request ? input.url : input,
          resolvedMain,
        );
        const rawTarget = beganRelative && target.origin === resolvedMain.origin
          ? `${target.pathname}${target.search}`
          : target.href;
        return runtime.fetchBuiltin(
          "fetchProgram",
          rawTarget,
          target,
          { ...init, signal: abortSignal },
        );
      },
    );

    // Program resolution parses; load the deferred compiler stack first.
    const { resolveProgram, ts } = await ensureCompilerStack();

    // Resolve the program with all dependencies
    const program = await resolveProgram(resolver, {
      unresolvedModules: { type: "allow-all" },
      resolveUnresolvedModuleTypes: true,
      target: ts.ScriptTarget.ES2023,
    });

    // Check if aborted during resolution
    if (abortSignal.aborted) return;

    await runtime.idle();

    // CAS: Only write if we're still the active request
    await runtime.editWithRetry((tx) => {
      const allEntries = cache.withTx(tx).get();
      const entry = allEntries[inputHash];
      if (
        entry?.state.type === "fetching" &&
        entry.state.requestId === requestId
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

    // CAS: Only write error if we're still the active request
    await runtime.editWithRetry((tx) => {
      const allEntries = cache.withTx(tx).get();
      const entry = allEntries[inputHash];
      if (
        entry?.state.type === "fetching" &&
        entry.state.requestId === requestId
      ) {
        cache.withTx(tx).update({
          [inputHash]: {
            inputHash,
            state: {
              type: "error",
              message: err instanceof Error ? err.message : String(err),
            },
          },
        });
      }
    });
  }
}
