import { FabricPrimitive } from "../interface.ts";

/**
 * Temporal type representing nanoseconds from the POSIX Epoch (1970-01-01T00:00:00Z).
 * Wraps a `bigint` value. Used for high-precision timestamps. Direct member of
 * `FabricValue` (not a `FabricInstance`).
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
