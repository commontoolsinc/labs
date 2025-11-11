import { refer } from "merkle-reference/json";
import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { JSONSchema, Schema } from "../builder/types.ts";
import { HttpProgramResolver } from "@commontools/js-runtime/program.ts";
import { resolveProgram } from "@commontools/js-runtime/typescript/resolver.ts";
import { TARGET } from "@commontools/js-runtime/typescript/options.ts";

const REQUEST_TIMEOUT = 1000 * 10; // 10 seconds for program resolution

const internalSchema = {
  type: "object",
  properties: {
    requestId: { type: "string", default: "" },
    lastActivity: { type: "number", default: 0 },
    inputHash: { type: "string", default: "" },
  },
  default: {},
  required: ["requestId", "lastActivity", "inputHash"],
} as const satisfies JSONSchema;

export interface ProgramResult {
  files: Array<{ name: string; contents: string }>;
  main: string;
}

/**
 * Computes a hash of the fetch inputs for comparison.
 */
function computeInputHash(
  tx: IExtendedStorageTransaction,
  inputsCell: Cell<{ url: string }>,
): string {
  const { url } = inputsCell.getAsQueryResult([], tx);
  return refer({ url: url ?? "" }).toString();
}

/**
 * Attempts to claim the mutex for a fetch request. Only claims if no other
 * request is active or if the previous request has timed out.
 */
async function tryClaimMutex(
  runtime: IRuntime,
  inputsCell: Cell<{ url: string }>,
  pending: Cell<boolean>,
  internal: Cell<Schema<typeof internalSchema>>,
  requestId: string,
): Promise<{
  claimed: boolean;
  url: string;
  inputHash: string;
}> {
  let claimed = false;
  let inputHash = "";
  let url = "";

  await runtime.editWithRetry((tx) => {
    const currentInternal = internal.withTx(tx).get();
    const isPending = pending.withTx(tx).get();
    const now = Date.now();

    ({ url } = inputsCell.getAsQueryResult([], tx));
    inputHash = computeInputHash(tx, inputsCell);

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
    } else {
      claimed = false;
    }
  });
  return { claimed, url, inputHash };
}

/**
 * Performs a mutation if the inputs haven't changed. This allows any tab
 * to write the result as long as the inputs are still the same.
 */
async function tryWriteResult(
  runtime: IRuntime,
  internal: Cell<Schema<typeof internalSchema>>,
  inputsCell: Cell<{ url: string }>,
  expectedHash: string,
  action: (tx: IExtendedStorageTransaction) => void,
): Promise<boolean> {
  let success = false;
  await runtime.editWithRetry((tx) => {
    const currentHash = computeInputHash(tx, inputsCell);

    // Only write if inputs haven't changed since we started the request
    if (currentHash === expectedHash) {
      action(tx);
      internal.withTx(tx).update({ inputHash: currentHash });
      success = true;
    }
  });
  return success;
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
      pending.withTx(tx).set(false);
      result.withTx(tx).set(undefined);
      error.withTx(tx).set(undefined);
      return;
    }

    // Check if inputs changed - if so, abort any in-flight request
    const currentInternal = internal.withTx(tx).get();
    if (myRequestId && currentInternal?.inputHash !== inputHash) {
      abortController?.abort("Inputs changed");
      myRequestId = undefined;
    }

    // Try to start a new request
    if (!myRequestId) {
      const newRequestId = crypto.randomUUID();

      // Try to claim mutex - returns immediately if another tab is processing
      tryClaimMutex(runtime, inputsCell, pending, internal, newRequestId).then(
        ({ claimed, url, inputHash }) => {
          if (!claimed) {
            // Another tab is handling this, we're done
            return;
          }

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
