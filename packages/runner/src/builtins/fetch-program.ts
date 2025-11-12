import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { Schema } from "../builder/types.ts";
import { HttpProgramResolver } from "@commontools/js-runtime";
import { resolveProgram, TARGET } from "@commontools/js-runtime/typescript";
import {
  computeInputHash,
  internalSchema,
  tryClaimMutex,
  tryWriteResult,
} from "./fetch-utils.ts";

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

      internal = runtime.getCell(
        parentCell.space,
        { fetchProgram: { internal: cause } },
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

    // Set results to links to our cells
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
      if (currentInternal?.inputHash !== "") {
        internal.withTx(tx).set({
          requestId: "",
          lastActivity: 0,
          inputHash: "",
        });
      }
      return;
    }

    // Check if inputs changed
    const currentInternal = internal.withTx(tx).get();
    const inputsChanged = currentInternal?.inputHash !== inputHash;

    if (inputsChanged) {
      // Abort any in-flight request
      if (myRequestId) {
        abortController?.abort("Inputs changed");
        myRequestId = undefined;
      }

      // Clear stale outputs immediately when inputs change
      result.withTx(tx).set(undefined);
      error.withTx(tx).set(undefined);
    }

    // Check if we already have a result for these inputs
    let currentPending = pending.withTx(tx).get();
    const currentResult = result.withTx(tx).get();

    // Clean up stuck pending state: if we have a valid result for current inputs
    // but pending is still true (e.g., app was shut down during a request),
    // clear the pending flag
    if (!inputsChanged && currentResult !== undefined && currentPending === true) {
      pending.withTx(tx).set(false);
      currentPending = false;
    }

    const hasResult = !inputsChanged &&
                      currentResult !== undefined &&
                      currentPending === false;

    // Try to start a new request only if we don't have a result and not currently pending
    if (!myRequestId && !hasResult && !currentPending) {
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
        PROGRAM_REQUEST_TIMEOUT,
      ).then(
        ({ claimed, inputs, inputHash }) => {
          if (!claimed) {
            // Another tab is handling this, we're done
            return;
          }

          const { url } = inputs;

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

          // We claimed the mutex, start the resolution
          myRequestId = newRequestId;
          startResolve(
            runtime,
            inputsCell,
            url,
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

async function startResolve(
  runtime: IRuntime,
  inputsCell: Cell<{ url: string }>,
  url: string,
  inputHash: string,
  pending: Cell<boolean>,
  result: Cell<ProgramResult | undefined>,
  error: Cell<any | undefined>,
  internal: Cell<Schema<typeof internalSchema>>,
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

    // Try to write result - any tab can write if inputs match
    await tryWriteResult(runtime, internal, inputsCell, inputHash, (tx) => {
      pending.withTx(tx).set(false);
      result.withTx(tx).set({
        files: program.files,
        main: program.main,
      });
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
      error.withTx(tx).set(
        err instanceof Error ? err.message : String(err),
      );
    });
  }
}
