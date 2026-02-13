import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { JSONSchema } from "../builder/types.ts";
import { HttpProgramResolver } from "@commontools/js-compiler";
import { resolveProgram, TARGET } from "@commontools/js-compiler/typescript";
import { computeInputHash } from "./fetch-utils.ts";

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

// Full schema for cache structure to ensure proper validation when reading back
// from storage. Without this, nested arrays may have undefined elements due to
// incomplete schema-based transformation.
const cacheSchema = {
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
} as const satisfies JSONSchema;

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
  let myRequestId: string | undefined = undefined;
  let abortController: AbortController | undefined = undefined;

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
        cacheSchema,
        tx,
      ) as Cell<Record<string, FetchCacheEntry>>;

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
    const allEntries = cache.withTx(tx).get();
    const cacheEntry = allEntries[inputHash];
    const state: FetchState = cacheEntry?.state ?? { type: "idle" };

    // State machine transitions
    if (state.type === "idle") {
      // Try to transition to fetching
      const requestId = crypto.randomUUID();
      cache.withTx(tx).update({
        [inputHash]: {
          inputHash,
          state: { type: "fetching", requestId, startTime: Date.now() },
        },
      });

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
