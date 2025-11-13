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
  const activeRequests = new Map<
    string,
    { requestId: string; controller: AbortController }
  >();

  // This is called when the recipe containing this node is being stopped.
  addCancel(() => {
    const activeEntries = Array.from(activeRequests.entries());
    for (const [, { controller }] of activeEntries) {
      controller.abort("Recipe stopped");
    }
    activeRequests.clear();

    if (!cellsInitialized) return;

    const tx = runtime.edit();

    try {
      const currentCache = cache.withTx(tx).get();
      for (const [hash, entry] of Object.entries(currentCache)) {
        const active = activeEntries.find(([k]) => k === hash)?.[1];
        if (
          entry.state.type === "fetching" &&
          active?.requestId === entry.state.requestId
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
        { fetchProgram: { cache: cause } },
        asyncOperationCacheSchema,
        tx,
      ) as Cell<Record<string, AsyncOperationCache<ProgramResult, string>>>;

      pending.setSourceCell(parentCell);
      result.setSourceCell(parentCell);
      error.setSourceCell(parentCell);
      cache.setSourceCell(parentCell);
      pending.sync();
      result.sync();
      error.sync();
      cache.sync();

      cellsInitialized = true;
    }

    const { url } = inputsCell.getAsQueryResult([], tx);
    const inputHash = computeInputHash(tx, inputsCell);

    if (!url) {
      const active = activeRequests.get(inputHash);
      active?.controller.abort("empty url");
      activeRequests.delete(inputHash);

      pending.withTx(tx).set(false);
      result.withTx(tx).set(undefined);
      error.withTx(tx).set(undefined);
      sendResult(tx, { pending, result, error });
      return;
    }

    const state = getState(cache, inputHash, tx);

    if (state.type === "idle") {
      const requestId = crypto.randomUUID();
      const didStart = transitionToFetching(cache, inputHash, requestId, tx);

      if (didStart) {
        const controller = new AbortController();
        activeRequests.set(inputHash, { requestId, controller });
        const signal = controller.signal;
        const urlToFetch = url;

        Promise.resolve().then(async () => {
          await runtime.idle();

          const confirmTx = runtime.edit();
          const confirmedState = getState(cache, inputHash, confirmTx);
          await confirmTx.commit();

          if (
            confirmedState.type === "fetching" &&
            confirmedState.requestId === requestId
          ) {
            try {
              await startFetchProgram(
                runtime,
                cache,
                inputHash,
                urlToFetch,
                requestId,
                signal,
              );
            } finally {
              activeRequests.delete(inputHash);
            }
          } else {
            activeRequests.delete(inputHash);
            controller.abort("Request superseded");
          }
        });
      }
    } else if (state.type === "fetching") {
      if (isTimedOut(state, PROGRAM_REQUEST_TIMEOUT)) {
        transitionToIdle(cache, inputHash, state.requestId, tx);
        const active = activeRequests.get(inputHash);
        if (active?.requestId === state.requestId) {
          active.controller.abort("timeout");
          activeRequests.delete(inputHash);
        }
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
