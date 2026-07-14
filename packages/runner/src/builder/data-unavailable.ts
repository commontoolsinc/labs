import type {
  HasErrorFunction,
  HasSchemaMismatchFunction,
  IsPendingFunction,
  IsSyncingFunction,
  ObserveAvailabilityFunction,
  PartialResultOfFunction,
  PartialResultSource,
  ResultOfFunction,
} from "@commonfabric/api";
import {
  hasError as hasErrorValue,
  hasSchemaMismatch as hasSchemaMismatchValue,
  isPending as isPendingValue,
  isSyncing as isSyncingValue,
} from "@commonfabric/data-model/fabric-instances";

/** Pure concrete-brand guard for the pending unavailable variant. */
export const isPending: IsPendingFunction = isPendingValue;

/** Pure concrete-brand guard for the error unavailable variant. */
export const hasError: HasErrorFunction = hasErrorValue;

/** Pure concrete-brand guard for the syncing unavailable variant. */
export const isSyncing: IsSyncingFunction = isSyncingValue;

/** Pure concrete-brand guard for the schema-mismatch unavailable variant. */
export const hasSchemaMismatch: HasSchemaMismatchFunction =
  hasSchemaMismatchValue;

/**
 * Runtime identity for the transformer-recognized availability observation
 * cast. It creates no builder node by itself.
 */
export const observeAvailability: ObserveAvailabilityFunction = ((
  value: unknown,
) => value) as ObserveAvailabilityFunction;

/**
 * Runtime identity for the transformer-recognized usable-result view. It
 * preserves the underlying reactive alias and creates no builder node.
 */
export const resultOf: ResultOfFunction = ((
  value: unknown,
) => value) as ResultOfFunction;

const partialResults = new WeakMap<object, unknown>();

function partialResultKey(value: unknown): object {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    throw new TypeError(
      "partialResultOf() requires a request returned by a streaming built-in",
    );
  }
  return value;
}

/** Associate one direct streaming result with its zero-node partial alias. */
export function associatePartialResult<Final, Partial>(
  result: unknown,
  partial: unknown,
): PartialResultSource<Final, Partial> {
  partialResults.set(partialResultKey(result), partial);
  return result as PartialResultSource<Final, Partial>;
}

/** Return the partial alias associated by a streaming built-in wrapper. */
export const partialResultOf: PartialResultOfFunction = ((value: unknown) => {
  const key = partialResultKey(value);
  if (!partialResults.has(key)) {
    throw new TypeError(
      "partialResultOf() requires a request returned by a streaming built-in",
    );
  }
  return partialResults.get(key);
}) as PartialResultOfFunction;
