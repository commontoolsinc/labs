import { refer } from "merkle-reference/json";
import { type Cell } from "../cell.ts";
import type { Runtime } from "../runtime.ts";
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
  runtime: Runtime,
  inputsCell: Cell<T>,
  pending: Cell<boolean>,
  _result: Cell<any>,
  _error: Cell<any>,
  internal: Cell<Schema<typeof internalSchema>>,
  requestId: string,
  snapshotInputs: (
    proxy: T,
    tx: IExtendedStorageTransaction,
  ) => T,
  timeout: number = REQUEST_TIMEOUT,
): Promise<{
  claimed: boolean;
  inputs: T;
  inputHash: string;
}> {
  let claimed = false;
  let inputHash = "";
  let inputs = {} as T;

  const maxRetries = 5;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Wait for all pending computeds to settle before reading inputs.
    // Without this, computed inputs (e.g. options) may still be undefined
    // on the first run because the scheduler hasn't evaluated them yet.
    // Re-waiting on each retry ensures we see settled state after conflicts.
    await runtime.idle();

    const tx = runtime.edit();
    tx.tx.immediate = true;

    const currentInternal = internal.withTx(tx).get();
    const isPending = pending.withTx(tx).get();
    const now = Date.now();

    // Snapshot inputs as plain data while the transaction is active.
    // The caller-provided snapshotInputs reads each field from the proxy
    // (which resolves entity-decomposed nested properties through the tx)
    // and returns a plain object safe to use after the transaction commits.
    const proxy = inputsCell.getAsQueryResult([], tx);
    inputs = snapshotInputs(proxy, tx);
    inputHash = computeInputHash(tx, inputsCell);

    // Can claim if:
    // 1. Nothing is pending, OR
    // 2. Previous request timed out
    const canClaim = !isPending ||
      (currentInternal.lastActivity < now - timeout);

    if (canClaim) {
      pending.withTx(tx).set(true);
      internal.withTx(tx).update({
        requestId,
        lastActivity: now,
      });
      claimed = true;
    } else {
      claimed = false;
    }

    const { error } = await tx.commit();
    if (!error) break;
    if (attempt === maxRetries) break;
  }

  return { claimed, inputs, inputHash };
}

/**
 * Performs a mutation if the inputs haven't changed. This allows any tab
 * to write the result as long as the inputs are still the same.
 */
export async function tryWriteResult<T extends Record<string, any>>(
  runtime: Runtime,
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
