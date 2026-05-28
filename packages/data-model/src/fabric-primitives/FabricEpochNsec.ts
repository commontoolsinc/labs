import type {
  FabricEpochNsec as ApiFabricEpochNsec,
  FabricEpochNsecConstructor as ApiFabricEpochNsecConstructor,
} from "@commonfabric/api";
import { FabricPrimitive } from "../interface.ts";

/**
 * Temporal type representing nanoseconds from the POSIX Epoch (1970-01-01T00:00:00Z).
 * Wraps a `bigint` value. Used for high-precision timestamps. Direct member of
 * `FabricValue` (not a `FabricInstance`).
 * See Section 1.4.6 of the formal spec.
 */
export class FabricEpochNsec extends FabricPrimitive
  implements ApiFabricEpochNsec {
  /** Nanoseconds from POSIX Epoch. Negative values represent pre-epoch timestamps. */
  readonly #value: bigint;

  constructor(value: bigint) {
    super();
    this.#value = value;
    Object.freeze(this);
  }

  /** Nanoseconds from POSIX Epoch. Negative values represent pre-epoch timestamps. */
  get value(): bigint {
    return this.#value;
  }
}

// Compile-time check that the exported `FabricEpochNsec` constructor matches the
// `FabricEpochNsecConstructor` declared in `@commonfabric/api`. This catches
// drift between the public type contract and this implementation.
FabricEpochNsec satisfies ApiFabricEpochNsecConstructor;
