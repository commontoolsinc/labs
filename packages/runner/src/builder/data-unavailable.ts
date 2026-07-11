import type {
  HasErrorFunction,
  HasSchemaMismatchFunction,
  IsPendingFunction,
  IsSyncingFunction,
  ObserveAvailabilityFunction,
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
