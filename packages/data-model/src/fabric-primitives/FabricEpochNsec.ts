import type {
  FabricEpochNsec as ApiFabricEpochNsec,
  FabricEpochNsecConstructor as ApiFabricEpochNsecConstructor,
} from "@commonfabric/api";
import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/utils/base64url";
import {
  bigintFromMinimalTwosComplement,
  bigintToMinimalTwosComplement,
} from "@commonfabric/utils/bigint";

import type { FabricValue } from "@/interface.ts";
import { BaseFabricPrimitive } from "./BaseFabricPrimitive.ts";
import { BaseFabricCodec } from "@/codec-common/BaseFabricCodec.ts";
import {
  CODEC,
  type FabricCodec,
  type ReconstructionContext,
} from "@/codec-common/interface.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";
import { WIRE_TYPE_TAGS } from "@/codec-common/wire-type-tags.ts";

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

  /** Nanoseconds from POSIX Epoch. Negative values represent pre-epoch timestamps. */
  get value(): bigint {
    return this.#value;
  }

  //
  // Static members
  //

  static #codec = Object.freeze(
    new (class EpochNsecCodec extends BaseFabricCodec {
      constructor() {
        super(WIRE_TYPE_TAGS.EpochNsec, FabricEpochNsec);
      }

      /** @inheritDoc */
      encode(value: FabricEpochNsec): FabricValue {
        return toUnpaddedBase64url(bigintToMinimalTwosComplement(value.#value));
      }

      /** @inheritDoc */
      decode(
        typeTag: string,
        state: FabricValue,
        _context: ReconstructionContext,
      ): FabricValue {
        if (typeof state !== "string") {
          return new ProblematicValue(
            typeTag,
            state,
            `EpochNsec: expected string state, got ${typeof state}`,
          );
        }
        try {
          return new FabricEpochNsec(
            bigintFromMinimalTwosComplement(fromBase64url(state)),
          );
        } catch {
          return new ProblematicValue(
            typeTag,
            state,
            `EpochNsec: invalid base64: ${state}`,
          );
        }
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): FabricCodec {
    return this.#codec;
  }
}

// Compile-time check that the exported `FabricEpochNsec` constructor matches the
// `FabricEpochNsecConstructor` declared in `@commonfabric/api`. This catches
// drift between the public type contract and this implementation.
FabricEpochNsec satisfies ApiFabricEpochNsecConstructor;
