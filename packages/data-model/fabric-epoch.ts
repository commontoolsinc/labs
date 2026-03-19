import { FabricPrimitive } from "./interface.ts";

/**
 * Temporal type representing nanoseconds from the POSIX Epoch (1970-01-01T00:00:00Z).
 * Wraps a `bigint` value. Used for high-precision timestamps. Direct member of
 * `FabricDatum` (not a `FabricInstance`).
 * See Section 1.4.6 of the formal spec.
 */
export class FabricEpochNsec extends FabricPrimitive {
  constructor(
    /** Nanoseconds from POSIX Epoch. Negative values represent pre-epoch timestamps. */
    readonly value: bigint,
  ) {
    super();
    Object.freeze(this);
  }
}

/**
 * Temporal type representing days from the POSIX Epoch (1970-01-01).
 * Wraps a `bigint` value. Used for date-only (no time) values. Direct member of
 * `FabricDatum` (not a `FabricInstance`).
 * See Section 1.4.7 of the formal spec.
 */
export class FabricEpochDays extends FabricPrimitive {
  constructor(
    /** Days from POSIX Epoch. Negative values represent pre-epoch dates. */
    readonly value: bigint,
  ) {
    super();
    Object.freeze(this);
  }
}
