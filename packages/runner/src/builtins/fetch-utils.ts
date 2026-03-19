import { refer } from "@commontools/data-model/value-hash";
import { storableFromNativeValue } from "@commontools/data-model/storable-value";
import { type Cell } from "../cell.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { Schema } from "../builder/types.ts";
import { toDeepFrozenSchema } from "@commontools/data-model/schema-utils";

export const REQUEST_TIMEOUT = 1000 * 5; // 5 seconds

export const internalSchema = toDeepFrozenSchema(
  {
    type: "object",
    properties: {
      requestId: { type: "string", default: "" },
      lastActivity: { type: "number", default: 0 },
      inputHash: { type: "string", default: "" },
    },
    default: {},
    required: ["requestId", "lastActivity", "inputHash"],
  },
  true,
);

/**
 * Computes a hash of inputs for comparison.
 * Excludes the 'result' field which is used only as a TypeScript type hint,
 * not as an actual input parameter.
 */
export function computeInputHashFromValue<T extends Record<string, any>>(
  inputs: T | undefined,
): string {
  const safeInputs = inputs ?? {};
  // Exclude 'result' type hint from the hash - only hash actual fetch parameters
  const inputsOnly = { ...(safeInputs as Record<string, unknown>) };
  delete (inputsOnly as Record<string, unknown>).result;
  // refer() cannot hash undefined values; normalize to a deep storable shape
  // (omits undefined object props, converts undefined array elements to null).
  const storableInputs = storableFromNativeValue(inputsOnly);
  const normalized = storableInputs === undefined ? {} : storableInputs;
  return refer(normalized as Record<string, unknown>).toString();
}

export function computeInputHash<T extends Record<string, any>>(
  tx: IExtendedStorageTransaction,
  inputsCell: Cell<T>,
): string {
  const inputs = inputsCell.getAsQueryResult([], tx) ?? {};
  return computeInputHashFromValue(inputs);
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
  snapshotInputs: (cell: Cell<T>) => T,
  timeout: number = REQUEST_TIMEOUT,
): Promise<{
  claimed: boolean;
  inputs: T;
  inputHash: string;
}> {
  let claimed = false;
  let inputHash = "";
  let inputs = {} as T;

  // Wait for all pending computeds to settle before reading inputs.
  // Without this, computed inputs (e.g. options) may still be undefined
  // on the first run because the scheduler hasn't evaluated them yet.
  await runtime.idle();

  await runtime.editWithRetry((tx) => {
    const currentInternal = internal.withTx(tx).get();
    const isPending = pending.withTx(tx).get();
    const now = Date.now();

    // The caller-provided snapshotInputs receives the cell with the active
    // transaction attached. It uses cell.asSchema(...).get() to materialize
    // a plain snapshot via the schema system, then does any additional
    // preprocessing (e.g. stringifying request bodies).
    inputs = snapshotInputs(inputsCell.withTx(tx));
    // Hash the snapshot (plain object) to avoid proxy/undefined issues
    // from partially-initialized reactive inputs.
    inputHash = computeInputHashFromValue(inputs);
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
  });

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
  snapshotInputs?: (cell: Cell<T>) => T,
): Promise<boolean> {
  let success = false;
  await runtime.editWithRetry((tx) => {
    const inputs = snapshotInputs
      ? snapshotInputs(inputsCell.withTx(tx))
      : inputsCell.getAsQueryResult([], tx);
    const currentHash = computeInputHashFromValue(inputs);

    // Only write if inputs haven't changed since we started the request
    if (currentHash === expectedHash) {
      action(tx);
      internal.withTx(tx).update({ inputHash: currentHash });
      success = true;
    }
  });
  return success;
}
