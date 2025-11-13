import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { HttpProgramResolver } from "@commontools/js-runtime";
import { resolveProgram, TARGET } from "@commontools/js-runtime/typescript";
import {
  type AsyncOperationCache,
  asyncOperationCacheSchema,
  computeInputHash,
  getState,
  isTimedOut,
  transitionToError,
  transitionToFetchingAsync,
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
  const myRequestIds = new Map<string, string>();
  const abortControllers = new Map<string, AbortController>();
  const claimPromises = new Map<string, Promise<void>>();

  // This is called when the recipe containing this node is being stopped.
  addCancel(() => {
    for (const controller of abortControllers.values()) {
      controller.abort("Recipe stopped");
    }
    abortControllers.clear();
    myRequestIds.clear();
    claimPromises.clear();

    if (!cellsInitialized) return;

    const tx = runtime.edit();

    try {
      const currentCache = cache.withTx(tx).get();
      for (const [hash, entry] of Object.entries(currentCache)) {
        if (
          entry.state.type === "fetching" &&
          myRequestIds.get(hash) === entry.state.requestId
        ) {
          transitionToIdle(cache, hash, entry.state.requestId, tx);
        }
      }

      tx.commit();
    } catch (_) {
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

      // Cache is shared across ALL fetchProgram operations (not per-recipe)
      cache = runtime.getCell(
        parentCell.space,
        "fetchProgram-global-cache",
        asyncOperationCacheSchema,
        tx,
      ) as Cell<Record<string, AsyncOperationCache<ProgramResult, string>>>;

      pending.setSourceCell(parentCell);
      result.setSourceCell(parentCell);
      error.setSourceCell(parentCell);
      pending.sync();
      result.sync();
      error.sync();
      cache.sync();

      cellsInitialized = true;
    }

    const { url } = inputsCell.getAsQueryResult([], tx);
    const inputHash = computeInputHash(tx, inputsCell);

    if (!url) {
      const controller = abortControllers.get(inputHash);
      controller?.abort("empty url");
      abortControllers.delete(inputHash);
      myRequestIds.delete(inputHash);
      claimPromises.delete(inputHash);

      pending.withTx(tx).set(false);
      result.withTx(tx).set(undefined);
      error.withTx(tx).set(undefined);
      sendResult(tx, { pending, result, error });
      return;
    }

    const state = getState(cache, inputHash, tx);

    if (state.type === "idle") {
      if (!claimPromises.has(inputHash)) {
        const requestId = crypto.randomUUID();
        const claimHash = inputHash;

        const claimPromise = (async () => {
          try {
            await cache.sync();

            const didStart = await transitionToFetchingAsync(
              runtime,
              cache,
              claimHash,
              requestId,
            );

            if (!didStart) return;

            myRequestIds.set(claimHash, requestId);

            await runtime.idle();

            const confirmTx = runtime.edit();
            const confirmedState = getState(cache, claimHash, confirmTx);
            await confirmTx.commit();

            if (
              confirmedState.type === "fetching" &&
              confirmedState.requestId === requestId
            ) {
              const controller = new AbortController();
              abortControllers.set(claimHash, controller);
              const signal = controller.signal;

              try {
                await startFetchProgram(
                  runtime,
                  cache,
                  claimHash,
                  url,
                  requestId,
                  signal,
                );
              } finally {
                if (abortControllers.get(claimHash) === controller) {
                  abortControllers.delete(claimHash);
                }
                if (myRequestIds.get(claimHash) === requestId) {
                  myRequestIds.delete(claimHash);
                }
              }
            } else {
              myRequestIds.delete(claimHash);
            }
          } catch (error) {
            console.error("fetchProgram claim failed", error);
            if (myRequestIds.get(claimHash) === requestId) {
              myRequestIds.delete(claimHash);
            }
            abortControllers.delete(claimHash);
          }
        })();

        claimPromises.set(inputHash, claimPromise);
        claimPromise.finally(() => {
          if (claimPromises.get(claimHash) === claimPromise) {
            claimPromises.delete(claimHash);
          }
        });
      }
    } else if (state.type === "fetching") {
      if (isTimedOut(state, PROGRAM_REQUEST_TIMEOUT)) {
        transitionToIdle(cache, inputHash, state.requestId, tx);
        const controller = abortControllers.get(inputHash);
        controller?.abort("timeout");
        abortControllers.delete(inputHash);
        myRequestIds.delete(inputHash);
        claimPromises.delete(inputHash);
      }
    }

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

async function startFetchProgram(
  runtime: IRuntime,
  cache: Cell<Record<string, AsyncOperationCache<ProgramResult, string>>>,
  inputHash: string,
  url: string,
  requestId: string,
  abortSignal: AbortSignal,
) {
  try {
    const resolver = new HttpProgramResolver(url);
    const program = await resolveProgram(resolver, {
      unresolvedModules: { type: "allow-all" },
      resolveUnresolvedModuleTypes: true,
      target: TARGET,
    });

    if (abortSignal.aborted) return;

    await runtime.idle();

    await transitionToSuccess(
      runtime,
      cache,
      inputHash,
      { files: program.files, main: program.main },
      requestId,
    );
  } catch (err) {
    if (abortSignal.aborted) return;

    await runtime.idle();

    await transitionToError(
      runtime,
      cache,
      inputHash,
      err instanceof Error ? err.message : String(err),
      requestId,
    );
  }
}
