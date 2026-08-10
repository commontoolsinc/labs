import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { stripUndefinedProps } from "@commonfabric/utils/strip-undefined-props";
import { type Cell } from "../cell.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { Schema } from "../builder/types.ts";
import { internSchema } from "@commonfabric/data-model/schema-hash";

/**
 * How long a claimed request mutex is believed before another replica may take
 * it over.
 *
 * This is not a bound on the request. A request issued here ends when its
 * promise settles or its AbortSignal fires, and `fetch.ts` decides from its own
 * state, not from the clock, whether it already has one in flight. The only
 * reader is a replica that finds a claim it did not make and has to decide
 * whether the replica that made it is still there. Nothing in the runner
 * reports another replica's presence, so that question has no event to wait on
 * and a staleness bound is the only answer available.
 *
 * The value is left where it was. Once an early takeover no longer costs a
 * result, the size is a trade with a cost on both sides: too low sends a second
 * copy of the request to the remote peer whenever another replica looks in
 * while one is running, too high leaves a replica that arrives before the bound
 * elapses looking at a claim it will not take over and has no reason to
 * re-examine, so the piece keeps showing a spinner. A duplicate request is
 * wasted work; a spinner that never resolves is a dead end, so the trade goes
 * to the lower value. A caller whose endpoint is slow enough that duplicates
 * matter raises its own bound with `options.mutexTimeoutMs`.
 *
 * `docs/features/fetch-request-deadlines.md` records why this bound stays
 * and what an early takeover costs.
 */
export const MUTEX_STALE_AFTER = 1000 * 5;

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
 * Attempts to claim the mutex for a request. Only claims if no other request
 * is active, or if the standing claim was made longer than `timeout` ago and is
 * therefore treated as abandoned (see {@link MUTEX_STALE_AFTER}). Claiming sets
 * pending=true and records the claim in `internal`; the caller clears
 * result/error to maintain the invariant that result/error are undefined while
 * pending.
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
  expectedInputHash?: string,
  timeout: number = MUTEX_STALE_AFTER,
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
    if (expectedInputHash !== undefined && inputHash !== expectedInputHash) {
      claimed = false;
      return;
    }
    // Can claim if:
    // 1. Nothing is pending, OR
    // 2. The standing claim has gone stale and is treated as abandoned
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
