import type {
  FabricEpochNsec as ApiFabricEpochNsec,
  FabricEpochNsecConstructor as ApiFabricEpochNsecConstructor,
} from "@commonfabric/api";

import { BaseFabricPrimitive } from "./BaseFabricPrimitive.ts";
import { WIRE_TYPE_TAGS } from "@/wire-common/wire-type-tags.ts";

/**
 * Temporal type representing nanoseconds from the POSIX Epoch (1970-01-01T00:00:00Z).
 * Wraps a `bigint` value. Used for high-precision timestamps.
 * See Section 1.4.6 of the formal spec.
 */
export class FabricEpochNsec extends BaseFabricPrimitive
  implements ApiFabricEpochNsec {
  /** Nanoseconds from POSIX Epoch. Negative values represent pre-epoch timestamps. */
  readonly #value: bigint;

  constructor(value: bigint) {
    super();
    this.#value = value;
    Object.freeze(this);
  }

  /** @inheritDoc */
  get wireTypeTag(): string {
    return WIRE_TYPE_TAGS.EpochNsec;
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
