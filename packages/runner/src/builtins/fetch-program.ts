import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { HttpProgramResolver } from "@commontools/js-runtime";
import { resolveProgram, TARGET } from "@commontools/js-runtime/typescript";
import { computeInputHash } from "./fetch-utils.ts";
import {
  type AsyncOperationCache,
  asyncOperationCacheSchema,
  getState,
  isTimedOut,
  transitionToError,
  transitionToFetching,
  transitionToIdle,
  transitionToSuccess,
} from "./async-operation-state.ts";

const PROGRAM_REQUEST_TIMEOUT = 1000 * 10; // 10 seconds for program resolution

export interface ProgramResult {
  files: Array<{ name: string; contents: string }>;
  main: string;
}

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
  runtime: IRuntime,
): Action {
  let cellsInitialized = false;
  let pending: Cell<boolean>;
  let result: Cell<ProgramResult | undefined>;
  let error: Cell<any | undefined>;
  let cache: Cell<Record<string, AsyncOperationCache<ProgramResult, string>>>;
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
      const updates: Record<
        string,
        AsyncOperationCache<ProgramResult, string>
      > = {};

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
        (cache as any).withTx(tx).update(updates);
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
        { fetchProgram: { pending: cause } },
        undefined,
        tx,
      );

      result = runtime.getCell<ProgramResult | undefined>(
        parentCell.space,
        {
          fetchProgram: { result: cause },
        },
        undefined,
        tx,
      );

      error = runtime.getCell<any | undefined>(
        parentCell.space,
        {
          fetchProgram: { error: cause },
        },
        undefined,
        tx,
      );

      cache = runtime.getCell(
        parentCell.space,
        { fetchProgram: { cache: cause } },
        asyncOperationCacheSchema,
        tx,
      ) as Cell<Record<string, AsyncOperationCache<ProgramResult, string>>>;

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
      // Try to transition to fetching
      const requestId = crypto.randomUUID();
      transitionToFetching(cache, inputHash, requestId, tx);

      // Start fetch asynchronously
      myRequestId = requestId;
      abortController = new AbortController();
      startFetch(
        runtime,
        cache,
        inputHash,
        url,
        requestId,
        abortController.signal,
      );
    } else if (state.type === "fetching") {
      // Check for timeout
      if (isTimedOut(state, PROGRAM_REQUEST_TIMEOUT)) {
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
 * Start fetching a program. Uses CAS to ensure only the tab that initiated
 * the fetch can write the result.
 */
async function startFetch(
  runtime: IRuntime,
  cache: Cell<Record<string, AsyncOperationCache<ProgramResult, string>>>,
  inputHash: string,
  url: string,
  requestId: string,
  abortSignal: AbortSignal,
) {
  try {
    // Create HTTP program resolver
    const resolver = new HttpProgramResolver(url);

    // Resolve the program with all dependencies
    const program = await resolveProgram(resolver, {
      unresolvedModules: { type: "allow-all" },
      resolveUnresolvedModuleTypes: true,
      target: TARGET,
    });

    // Check if aborted during resolution
    if (abortSignal.aborted) return;

    await runtime.idle();

    // CAS: Only write if we're still the active request
    await transitionToSuccess(
      runtime,
      cache,
      inputHash,
      { files: program.files, main: program.main },
      requestId,
    );
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
