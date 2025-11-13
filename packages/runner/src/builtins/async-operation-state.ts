import type { Cell } from "../cell.ts";
import type { IRuntime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { JSONSchema } from "../builder/types.ts";

/**
 * Generic state machine for async operations (fetches, compilations, LLM calls, etc.)
 *
 * States:
 * - idle: No operation in progress, no cached result
 * - fetching: Operation in progress (with requestId and startTime for timeout tracking)
 *   - partial: Optional streaming/incremental data (for LLM text generation, etc.)
 * - success: Operation completed successfully with data
 * - error: Operation failed with error message
 */
export type AsyncOperationState<T, E = string> =
  | { type: "idle" }
  | { type: "fetching"; requestId: string; startTime: number; partial?: string }
  | { type: "success"; data: T }
  | { type: "error"; error: E };

/**
 * Cache entry associating an input hash with its operation state
 */
export interface AsyncOperationCache<T, E = string> {
  inputHash: string;
  state: AsyncOperationState<T, E>;
}

/**
 * JSON schema for the cache (Record<inputHash, CacheEntry>)
 */
export const asyncOperationCacheSchema = {
  type: "object",
  default: {},
} as const satisfies JSONSchema;

/**
 * Transition the state machine to "fetching" state.
 * Creates a new cache entry with the given requestId and current timestamp.
 *
 * @param cache - The cache cell to update
 * @param inputHash - Hash of the inputs for this operation
 * @param requestId - Unique ID for this request
 * @param tx - Transaction to perform the update in
 */
export function transitionToFetching<T, E = string>(
  cache: Cell<Record<string, AsyncOperationCache<T, E>>>,
  inputHash: string,
  requestId: string,
  tx: IExtendedStorageTransaction,
): void {
  cache.withTx(tx).update({
    [inputHash]: {
      inputHash,
      state: { type: "fetching", requestId, startTime: Date.now() },
    },
  });
}

/**
 * Attempt to transition to "success" state using CAS (Compare-And-Swap).
 * Only succeeds if the current state is still "fetching" with the expected requestId.
 *
 * @param runtime - Runtime for creating transactions
 * @param cache - The cache cell to update
 * @param inputHash - Hash of the inputs for this operation
 * @param data - The successful result data
 * @param requestId - Expected requestId (for CAS check)
 * @returns Promise<boolean> - true if the transition succeeded
 */
export async function transitionToSuccess<T, E = string>(
  runtime: IRuntime,
  cache: Cell<Record<string, AsyncOperationCache<T, E>>>,
  inputHash: string,
  data: T,
  requestId: string,
): Promise<boolean> {
  let success = false;
  await runtime.editWithRetry((tx) => {
    const allEntries = cache.withTx(tx).get();
    const entry = allEntries[inputHash];
    if (
      entry?.state.type === "fetching" &&
      entry.state.requestId === requestId
    ) {
      // Cast to any to work around TypeScript's complex union type inference
      (cache as any).withTx(tx).update({
        [inputHash]: {
          inputHash,
          state: { type: "success", data },
        },
      });
      success = true;
    }
  });
  return success;
}

/**
 * Attempt to transition to "error" state using CAS (Compare-And-Swap).
 * Only succeeds if the current state is still "fetching" with the expected requestId.
 *
 * @param runtime - Runtime for creating transactions
 * @param cache - The cache cell to update
 * @param inputHash - Hash of the inputs for this operation
 * @param error - The error that occurred
 * @param requestId - Expected requestId (for CAS check)
 * @returns Promise<boolean> - true if the transition succeeded
 */
export async function transitionToError<T, E = string>(
  runtime: IRuntime,
  cache: Cell<Record<string, AsyncOperationCache<T, E>>>,
  inputHash: string,
  error: E,
  requestId: string,
): Promise<boolean> {
  let success = false;
  await runtime.editWithRetry((tx) => {
    const allEntries = cache.withTx(tx).get();
    const entry = allEntries[inputHash];
    if (
      entry?.state.type === "fetching" &&
      entry.state.requestId === requestId
    ) {
      // Cast to any to work around TypeScript's complex union type inference
      (cache as any).withTx(tx).update({
        [inputHash]: {
          inputHash,
          state: { type: "error", error },
        },
      });
      success = true;
    }
  });
  return success;
}

/**
 * Transition to "idle" state if the current state is "fetching" with the expected requestId.
 * Used for timeout handling or abort scenarios.
 *
 * @param cache - The cache cell to update
 * @param inputHash - Hash of the inputs for this operation
 * @param requestId - Expected requestId (for CAS check)
 * @param tx - Transaction to perform the update in
 */
export function transitionToIdle<T, E = string>(
  cache: Cell<Record<string, AsyncOperationCache<T, E>>>,
  inputHash: string,
  requestId: string,
  tx: IExtendedStorageTransaction,
): void {
  const allEntries = cache.withTx(tx).get();
  const entry = allEntries[inputHash];
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
}

/**
 * Check if a "fetching" state has timed out.
 *
 * @param state - The current state
 * @param timeout - Timeout in milliseconds
 * @returns boolean - true if the state is "fetching" and has exceeded the timeout
 */
export function isTimedOut<T, E = string>(
  state: AsyncOperationState<T, E>,
  timeout: number,
): boolean {
  return (
    state.type === "fetching" && Date.now() - state.startTime > timeout
  );
}

/**
 * Get the current state for a given input hash from the cache.
 *
 * @param cache - The cache cell
 * @param inputHash - Hash of the inputs
 * @param tx - Transaction to read from
 * @returns The current state, or idle if not found
 */
export function getState<T, E = string>(
  cache: Cell<Record<string, AsyncOperationCache<T, E>>>,
  inputHash: string,
  tx: IExtendedStorageTransaction,
): AsyncOperationState<T, E> {
  const allEntries = cache.withTx(tx).get();
  const entry = allEntries[inputHash];
  return entry?.state ?? { type: "idle" };
}

/**
 * Update the partial field in a "fetching" state (for streaming operations).
 * Only updates if the current state is "fetching" with the expected requestId.
 *
 * @param runtime - Runtime for creating transactions
 * @param cache - The cache cell to update
 * @param inputHash - Hash of the inputs for this operation
 * @param partial - The partial/streaming data to update
 * @param requestId - Expected requestId (for CAS check)
 */
export async function updatePartial<T, E = string>(
  runtime: IRuntime,
  cache: Cell<Record<string, AsyncOperationCache<T, E>>>,
  inputHash: string,
  partial: string,
  requestId: string,
): Promise<void> {
  await runtime.editWithRetry((tx) => {
    const allEntries = cache.withTx(tx).get();
    const entry = allEntries[inputHash];
    if (
      entry?.state.type === "fetching" &&
      entry.state.requestId === requestId
    ) {
      // Cast to any to work around TypeScript's complex union type inference
      (cache as any).withTx(tx).update({
        [inputHash]: {
          inputHash,
          state: {
            type: "fetching",
            requestId: entry.state.requestId,
            startTime: entry.state.startTime,
            partial,
          },
        },
      });
    }
  });
}
