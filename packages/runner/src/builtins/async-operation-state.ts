import { refer } from "merkle-reference/json";
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

// ============================================================================
// Core CAS Implementation
// ============================================================================

/**
 * Core Compare-And-Swap (CAS) transition function.
 * Only performs the transition if the current state matches expectations.
 *
 * This is the **single source of truth** for all state transitions.
 * All other transition functions are built on top of this.
 *
 * @param cache - The cache cell to update
 * @param inputHash - Hash of the inputs for this operation
 * @param expectedState - Expected current state type (or null for non-existent/idle)
 * @param expectedRequestId - Expected requestId (only checked for "fetching" state)
 * @param nextState - The new state to transition to
 * @param tx - Transaction to perform the update in
 * @returns boolean - true if transition succeeded, false if state mismatch
 */
function casTransition<T, E = string>(
  cache: Cell<Record<string, AsyncOperationCache<T, E>>>,
  inputHash: string,
  expectedState: AsyncOperationState<T, E>["type"] | null,
  expectedRequestId: string | null,
  nextState: AsyncOperationState<T, E>,
  tx: IExtendedStorageTransaction,
): boolean {
  const allEntries = cache.withTx(tx).get();
  const entry = allEntries[inputHash];
  const currentStateType = entry?.state.type ?? null;

  // Check if current state matches expected state
  if (currentStateType !== expectedState) {
    return false; // State changed, abort transition
  }

  // For fetching state, also verify requestId matches
  if (
    expectedState === "fetching" &&
    entry?.state.type === "fetching" &&
    entry.state.requestId !== expectedRequestId
  ) {
    return false; // Different request is in flight
  }

  // CAS succeeded - perform transition
  // Type cast needed because TypeScript can't prove state union correctness
  if (nextState.type === "idle") {
    (cache as any).withTx(tx).key(inputHash).set(undefined);
  } else {
    (cache as any).withTx(tx).update({
      [inputHash]: {
        inputHash,
        state: nextState,
      },
    });
  }

  return true;
}

/**
 * Async wrapper around casTransition using editWithRetry for cross-runtime safety.
 * Use this when transitioning from outside a transaction (e.g., in async callbacks).
 */
async function casTransitionAsync<T, E = string>(
  runtime: IRuntime,
  cache: Cell<Record<string, AsyncOperationCache<T, E>>>,
  inputHash: string,
  expectedState: AsyncOperationState<T, E>["type"] | null,
  expectedRequestId: string | null,
  nextState: AsyncOperationState<T, E>,
): Promise<boolean> {
  let success = false;
  await runtime.editWithRetry((tx) => {
    success = casTransition(
      cache,
      inputHash,
      expectedState,
      expectedRequestId,
      nextState,
      tx,
    );
  });
  return success;
}

// ============================================================================
// Public API: High-Level Transition Functions
// ============================================================================

/**
 * Attempt to transition from idle → fetching.
 * Only succeeds if no other runtime has claimed this work.
 *
 * Use this at the START of an async operation to claim ownership.
 * Returns true if this runtime won the race and should start the work.
 *
 * @example
 * const requestId = crypto.randomUUID();
 * const didStart = transitionToFetching(cache, inputHash, requestId, tx);
 * if (didStart) {
 *   // Start the async operation
 * }
 */
export function transitionToFetching<T, E = string>(
  cache: Cell<Record<string, AsyncOperationCache<T, E>>>,
  inputHash: string,
  requestId: string,
  tx: IExtendedStorageTransaction,
): boolean {
  return casTransition(
    cache,
    inputHash,
    null, // Expect idle or non-existent
    null,
    { type: "fetching", requestId, startTime: Date.now() },
    tx,
  );
}

export async function transitionToFetchingAsync<T, E = string>(
  runtime: IRuntime,
  cache: Cell<Record<string, AsyncOperationCache<T, E>>>,
  inputHash: string,
  requestId: string,
): Promise<boolean> {
  return await casTransitionAsync(
    runtime,
    cache,
    inputHash,
    null,
    null,
    { type: "fetching", requestId, startTime: Date.now() },
  );
}

/**
 * Complete an async operation with success.
 * Only succeeds if still fetching with the expected requestId.
 *
 * Use this at the END of a successful async operation.
 * Returns true if the result was saved, false if another request superseded this one.
 *
 * @example
 * const success = await transitionToSuccess(runtime, cache, inputHash, data, requestId);
 * if (!success) {
 *   // Another request won, discard our result
 * }
 */
export async function transitionToSuccess<T, E = string>(
  runtime: IRuntime,
  cache: Cell<Record<string, AsyncOperationCache<T, E>>>,
  inputHash: string,
  data: T,
  requestId: string,
): Promise<boolean> {
  return await casTransitionAsync(
    runtime,
    cache,
    inputHash,
    "fetching",
    requestId,
    { type: "success", data },
  );
}

/**
 * Complete an async operation with error.
 * Only succeeds if still fetching with the expected requestId.
 *
 * Use this when an async operation fails.
 * Returns true if the error was saved, false if another request superseded this one.
 */
export async function transitionToError<T, E = string>(
  runtime: IRuntime,
  cache: Cell<Record<string, AsyncOperationCache<T, E>>>,
  inputHash: string,
  error: E,
  requestId: string,
): Promise<boolean> {
  return await casTransitionAsync(
    runtime,
    cache,
    inputHash,
    "fetching",
    requestId,
    { type: "error", error },
  );
}

/**
 * Cancel/timeout a fetch, returning to idle.
 * Only succeeds if still fetching with the expected requestId.
 *
 * Use this for timeout handling or explicit cancellation.
 * After this, another runtime can claim the work.
 */
export function transitionToIdle<T, E = string>(
  cache: Cell<Record<string, AsyncOperationCache<T, E>>>,
  inputHash: string,
  requestId: string,
  tx: IExtendedStorageTransaction,
): boolean {
  return casTransition(
    cache,
    inputHash,
    "fetching",
    requestId,
    { type: "idle" },
    tx,
  );
}

/**
 * Update partial/streaming data during fetch.
 * Only succeeds if still fetching with the expected requestId.
 *
 * Use this for streaming operations like LLM text generation.
 * Preserves the existing requestId and startTime.
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
      casTransition(
        cache,
        inputHash,
        "fetching",
        requestId,
        {
          type: "fetching",
          requestId: entry.state.requestId,
          startTime: entry.state.startTime,
          partial,
        },
        tx,
      );
    }
  });
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get current state for a given input hash.
 * Returns idle if no entry exists.
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
 * Check if a "fetching" state has timed out.
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
 * Compute input hash for deduplication.
 * Excludes 'result' field which is just a type hint.
 */
export function computeInputHash<T extends Record<string, any>>(
  tx: IExtendedStorageTransaction,
  inputsCell: Cell<T>,
): string {
  const inputs = inputsCell.getAsQueryResult([], tx);
  const { result: _result, ...inputsOnly } = inputs;
  return refer(inputsOnly).toString();
}
