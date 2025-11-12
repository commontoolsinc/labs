import { refer } from "merkle-reference/json";
import { type Cell } from "../cell.ts";
import type { IRuntime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { JSONSchema, Schema } from "../builder/types.ts";

export const REQUEST_TIMEOUT = 1000 * 5; // 5 seconds

export const internalSchema = {
  type: "object",
  properties: {
    requestId: { type: "string", default: "" },
    lastActivity: { type: "number", default: 0 },
    inputHash: { type: "string", default: "" },
  },
  default: {},
  required: ["requestId", "lastActivity", "inputHash"],
} as const satisfies JSONSchema;

/**
 * Computes a hash of inputs for comparison.
 * Excludes the 'result' field which is used only as a TypeScript type hint,
 * not as an actual input parameter.
 */
export function computeInputHash<T extends Record<string, any>>(
  tx: IExtendedStorageTransaction,
  inputsCell: Cell<T>,
): string {
  const inputs = inputsCell.getAsQueryResult([], tx);
  // Exclude 'result' type hint from the hash - only hash actual fetch parameters
  const { result: _result, ...inputsOnly } = inputs;
  return refer(inputsOnly).toString();
}

/**
 * Attempts to claim the mutex for a request. Only claims if no other
 * request is active or if the previous request has timed out.
 * When claiming, sets pending=true and clears result/error to maintain
 * the invariant that result/error are undefined while pending.
 */
export async function tryClaimMutex<T extends Record<string, any>>(
  runtime: IRuntime,
  inputsCell: Cell<T>,
  pending: Cell<boolean>,
  result: Cell<any>,
  error: Cell<any>,
  internal: Cell<Schema<typeof internalSchema>>,
  requestId: string,
  timeout: number = REQUEST_TIMEOUT,
): Promise<{
  claimed: boolean;
  inputs: T;
  inputHash: string;
}> {
  let claimed = false;
  let inputHash = "";
  let inputs = {} as T;

  await runtime.editWithRetry((tx) => {
    const currentInternal = internal.withTx(tx).get();
    const isPending = pending.withTx(tx).get();
    const currentResult = result.withTx(tx).get();
    const now = Date.now();

    inputs = inputsCell.getAsQueryResult([], tx);
    inputHash = computeInputHash(tx, inputsCell);

    // Don't claim if we already have a valid result for these inputs
    const hasValidResult = currentResult !== undefined &&
                           currentInternal.inputHash === inputHash;

    if (hasValidResult) {
      // Clean up stuck pending state if we have a valid result
      if (isPending) {
        pending.withTx(tx).set(false);
      }
      claimed = false;
      return;
    }

    // Can claim if:
    // 1. Nothing is pending, OR
    // 2. Previous request timed out, OR
    // 3. Inputs changed (different hash)
    const canClaim = !isPending ||
      (currentInternal.lastActivity < now - timeout) ||
      (currentInternal.inputHash !== inputHash);

    if (canClaim) {
      pending.withTx(tx).set(true);
      // Clear result and error when starting a new request to maintain
      // the invariant that they're undefined while pending
      result.withTx(tx).set(undefined);
      error.withTx(tx).set(undefined);
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
  return { claimed, inputs, inputHash };
}

/**
 * Performs a mutation if the inputs haven't changed. This allows any tab
 * to write the result as long as the inputs are still the same.
 */
export async function tryWriteResult<T extends Record<string, any>>(
  runtime: IRuntime,
  internal: Cell<Schema<typeof internalSchema>>,
  inputsCell: Cell<T>,
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
