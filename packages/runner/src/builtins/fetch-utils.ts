import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { stripUndefinedProps } from "@commonfabric/utils/strip-undefined-props";
import { type Cell } from "../cell.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { Schema } from "../builder/types.ts";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import {
  DataUnavailable,
  type DataUnavailableVariant,
  FabricError,
  isDataUnavailable,
} from "@commonfabric/data-model/fabric-instances";
import { selectUnavailableInput } from "../data-unavailability.ts";

export const REQUEST_TIMEOUT = 1000 * 5; // 5 seconds

export const internalSchema = internSchema(
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
);

/**
 * Selects the unavailable marker controlling a raw fetch invocation.
 * Reasons use the runner-wide precedence, with ties retaining depth-first
 * serialized argument order. Structural lookalikes are ordinary data.
 */
export function selectUnavailableFetchInput(
  value: unknown,
  resolution?: {
    runtime: Runtime;
    tx: IExtendedStorageTransaction;
    base: Cell<unknown>;
  },
): DataUnavailableVariant | undefined {
  return selectUnavailableInput(value, resolution, {
    // `result` is a top-level TypeScript/schema hint, not a request input.
    // Keep availability selection aligned with request hashing.
    skipTopLevelKeys: ["result"],
  });
}

/**
 * Reconstructs the direct marker for state persisted by the pre-AsyncResult
 * fetch implementation. Existing usable values and already-migrated markers
 * always win; an old terminal error takes precedence over its pending sibling.
 */
export function legacyFetchResultMarker(
  currentResult: unknown,
  currentPending: boolean,
  currentError: unknown,
): DataUnavailableVariant | undefined {
  if (currentResult !== undefined) return undefined;
  if (currentError !== undefined) {
    if (currentError instanceof Error || currentError instanceof FabricError) {
      return DataUnavailable.error(currentError);
    }
    const message = currentError !== null && typeof currentError === "object" &&
        typeof (currentError as { message?: unknown }).message === "string"
      ? (currentError as { message: string }).message
      : String(currentError);
    const error = new Error(message);
    if (
      currentError !== null && typeof currentError === "object" &&
      typeof (currentError as { name?: unknown }).name === "string"
    ) {
      error.name = (currentError as { name: string }).name;
    }
    return DataUnavailable.error(error);
  }
  return currentPending ? DataUnavailable.pending() : undefined;
}

/** Writes a direct unavailable result while retaining legacy sibling state. */
export function writeUnavailableFetchResult(
  tx: IExtendedStorageTransaction,
  pending: Cell<boolean>,
  result: Cell<any>,
  error: Cell<any>,
  unavailable: DataUnavailableVariant,
  legacyError?: unknown,
): void {
  pending.withTx(tx).set(unavailable.reason === "pending");
  result.withTx(tx).setRaw(unavailable);
  error.withTx(tx).set(legacyError ?? unavailable.error);
}

/**
 * Computes a stable string hash of fetch-style inputs, suitable for use as
 * a comparison key (e.g. an idempotency key or mutex identifier).
 *
 * Two normalizations are applied before hashing:
 *
 * (1) The top-level `result` property and `options.mutexTimeoutMs` property
 *     are dropped. `result` exists only as a TypeScript type hint at call
 *     sites, and `mutexTimeoutMs` is a local scheduling knob. Neither is a
 *     real fetch parameter, so neither must influence the hash.
 *
 * (2) `undefined`-valued object properties are dropped, recursively.
 *     Callers commonly materialize snapshots via unconditional object
 *     construction (e.g. `{ url, mode, options }`, or one level deeper
 *     `{ method, body }`), and the resulting hash needs to be the same
 *     regardless of whether an absent field is omitted entirely or
 *     present-but-`undefined`. The fabric-value layer preserves
 *     `undefined`-valued properties, so this function must do the
 *     JSON-style normalization itself.
 *
 * `hashStringOf()` itself is happy to hash `undefined` values; no
 * normalization for hashability per se is needed.
 */
export function computeInputHashFromValue<T extends Record<string, any>>(
  inputs: T | undefined,
): string {
  const { result: _result, ...inputsOnly } = (inputs ?? {}) as Record<
    string,
    unknown
  >;
  const options = inputsOnly.options;
  if (
    options !== null && typeof options === "object" &&
    !Array.isArray(options)
  ) {
    const {
      mutexTimeoutMs: _mutexTimeoutMs,
      ...requestOptions
    } = options as Record<string, unknown>;
    const normalizedOptions = stripUndefinedProps(requestOptions) as Record<
      string,
      unknown
    >;
    if (Object.keys(normalizedOptions).length > 0) {
      inputsOnly.options = normalizedOptions;
    } else {
      delete inputsOnly.options;
    }
  }
  return hashStringOf(stripUndefinedProps(inputsOnly));
}

export function computeInputHash<T extends Record<string, any>>(
  tx: IExtendedStorageTransaction,
  inputsCell: Cell<T>,
): string {
  const inputs = inputsCell.getAsQueryResult([], tx) ?? {};
  return computeInputHashFromValue(inputs);
}

/**
 * Synchronously revalidates an approved fetch snapshot immediately before its
 * external effect starts. The outbox release and mutex claim each validate at
 * their own transaction boundary; this closes the remaining hand-off window
 * where live inputs can change after those checks but before fetch begins.
 */
export function liveFetchInputsMatch<
  TInputs extends Record<string, any>,
  TSnapshot extends Record<string, any>,
>(
  runtime: Runtime,
  inputsCell: Cell<TInputs>,
  snapshotInputs: (cell: Cell<TInputs>) => TSnapshot,
  expectedInputHash: string,
): boolean {
  const tx = runtime.edit();
  try {
    const unavailable = selectUnavailableFetchInput(
      inputsCell.withTx(tx).getRaw(),
      { runtime, tx, base: inputsCell },
    );
    if (unavailable !== undefined) return false;
    return computeInputHashFromValue(snapshotInputs(inputsCell.withTx(tx))) ===
      expectedInputHash;
  } finally {
    tx.abort();
  }
}

/** Revalidates both live inputs and ownership of a pending mutex claim. */
export function liveFetchClaimMatches<
  TInputs extends Record<string, any>,
  TSnapshot extends Record<string, any>,
>(
  runtime: Runtime,
  inputsCell: Cell<TInputs>,
  snapshotInputs: (cell: Cell<TInputs>) => TSnapshot,
  expectedInputHash: string,
  internal: Cell<Schema<typeof internalSchema>>,
  result: Cell<unknown>,
  requestId: string,
): boolean {
  const tx = runtime.edit();
  try {
    const unavailable = selectUnavailableFetchInput(
      inputsCell.withTx(tx).getRaw(),
      { runtime, tx, base: inputsCell },
    );
    if (unavailable !== undefined) return false;

    const liveHash = computeInputHashFromValue(
      snapshotInputs(inputsCell.withTx(tx)),
    );
    const currentInternal = internal.withTx(tx).get();
    const currentResult = result.withTx(tx).getRaw();
    return liveHash === expectedInputHash &&
      currentInternal.inputHash === expectedInputHash &&
      currentInternal.requestId === requestId &&
      isDataUnavailable(currentResult) &&
      currentResult.reason === "pending";
  } finally {
    tx.abort();
  }
}

/**
 * Arms recovery for a non-terminal mutex claim whose owner is not local.
 * The exact claim is released only after its lease expires and only while
 * live inputs and the direct pending result still match.
 */
export function scheduleFetchMutexClaimRetry<
  TInputs extends Record<string, any>,
  TSnapshot extends Record<string, any>,
>(
  runtime: Runtime,
  inputsCell: Cell<TInputs>,
  snapshotInputs: (cell: Cell<TInputs>) => TSnapshot,
  result: Cell<unknown>,
  internal: Cell<Schema<typeof internalSchema>>,
  expectedInputHash: string,
  requestId: string,
  lastActivity: number,
  timeout: number,
): () => void {
  const delay = Math.max(0, lastActivity + timeout - Date.now());
  const timer = setTimeout(() => {
    void runtime.editWithRetry((tx) => {
      const unavailable = selectUnavailableFetchInput(
        inputsCell.withTx(tx).getRaw(),
        { runtime, tx, base: inputsCell },
      );
      if (unavailable !== undefined) return;

      const liveHash = computeInputHashFromValue(
        snapshotInputs(inputsCell.withTx(tx)),
      );
      const currentInternal = internal.withTx(tx).get();
      const currentResult = result.withTx(tx).getRaw();
      if (
        liveHash === expectedInputHash &&
        currentInternal.inputHash === expectedInputHash &&
        currentInternal.requestId === requestId &&
        currentInternal.lastActivity <= Date.now() - timeout &&
        isDataUnavailable(currentResult) &&
        currentResult.reason === "pending"
      ) {
        internal.withTx(tx).update({
          requestId: "",
          lastActivity: 0,
        });
      }
    }).catch(() => {
      // Runtime shutdown or a conflicting owner will reconcile separately.
    });
  }, delay + 1);
  return () => clearTimeout(timer);
}

/**
 * Attempts to claim the mutex for a request. Only claims if no other
 * request is active or if the previous request has timed out.
 * When claiming, atomically publishes the pending marker and retains the
 * legacy pending/error sibling cells during the API transition.
 */
export async function tryClaimMutex<T extends Record<string, any>>(
  runtime: Runtime,
  inputsCell: Cell<T>,
  pending: Cell<boolean>,
  result: Cell<any>,
  error: Cell<any>,
  internal: Cell<Schema<typeof internalSchema>>,
  requestId: string,
  snapshotInputs: (cell: Cell<T>) => T,
  expectedInputHash?: string,
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
    // Re-check availability inside the mutex transaction. The outbox release
    // and the reactive builtin action can race: a prior request may still be
    // published as pending when the live input has already become unavailable.
    // Snapshot hashing alone is not a sufficient guard because schema
    // projection can hide the marker or normalize it to the prior hash.
    const unavailable = selectUnavailableFetchInput(
      inputsCell.withTx(tx).getRaw(),
      { runtime, tx, base: inputsCell },
    );
    if (unavailable !== undefined) {
      claimed = false;
      return;
    }

    const currentInternal = internal.withTx(tx).get();
    const isPending = pending.withTx(tx).get();
    const currentResult = result.withTx(tx).getRaw();
    const now = Date.now();

    // The caller-provided snapshotInputs receives the cell with the active
    // transaction attached. It uses cell.asSchema(...).get() to materialize
    // a plain snapshot via the schema system, then does any additional
    // preprocessing (e.g. stringifying request bodies).
    inputs = snapshotInputs(inputsCell.withTx(tx));
    // Hash the snapshot (plain object) to avoid proxy/undefined issues
    // from partially-initialized reactive inputs.
    inputHash = computeInputHashFromValue(inputs);
    if (expectedInputHash !== undefined && inputHash !== expectedInputHash) {
      claimed = false;
      return;
    }
    // Can claim if:
    // 1. Nothing is pending, OR
    // 2. Previous request timed out
    const hasSettledResult = currentResult !== undefined &&
      !(isDataUnavailable(currentResult) &&
        currentResult.reason === "pending");
    const canClaim = !hasSettledResult &&
      (
        !isPending || currentInternal.requestId === "" ||
        currentInternal.lastActivity < now - timeout
      );

    if (canClaim) {
      writeUnavailableFetchResult(
        tx,
        pending,
        result,
        error,
        DataUnavailable.pending(),
      );
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
  expectedRequestId?: string,
): Promise<boolean> {
  let success = false;
  await runtime.editWithRetry((tx) => {
    const unavailable = selectUnavailableFetchInput(
      inputsCell.withTx(tx).getRaw(),
      { runtime, tx, base: inputsCell },
    );
    if (unavailable !== undefined) return;

    const currentInternal = internal.withTx(tx).get();
    if (
      expectedRequestId !== undefined &&
      currentInternal.requestId !== expectedRequestId
    ) return;

    const inputs = snapshotInputs
      ? snapshotInputs(inputsCell.withTx(tx))
      : inputsCell.getAsQueryResult([], tx);
    const currentHash = computeInputHashFromValue(inputs);

    // Only write if inputs haven't changed since we started the request
    if (currentHash === expectedHash) {
      action(tx);
      internal.withTx(tx).update({
        inputHash: currentHash,
        ...(expectedRequestId !== undefined && {
          requestId: "",
          lastActivity: 0,
        }),
      });
      success = true;
    }
  });
  return success;
}

/** Releases a just-acquired claim only if it still belongs to this request. */
export async function releaseFetchMutexClaim(
  runtime: Runtime,
  internal: Cell<Schema<typeof internalSchema>>,
  expectedInputHash: string,
  requestId: string,
): Promise<void> {
  await runtime.editWithRetry((tx) => {
    const current = internal.withTx(tx).get();
    if (
      current.inputHash === expectedInputHash &&
      current.requestId === requestId
    ) {
      internal.withTx(tx).update({ requestId: "", lastActivity: 0 });
    }
  });
}
