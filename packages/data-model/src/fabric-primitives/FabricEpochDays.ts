import type {
  FabricEpochDays as ApiFabricEpochDays,
  FabricEpochDaysConstructor as ApiFabricEpochDaysConstructor,
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
import { BaseFabricCodec } from "@/wire-common/BaseFabricCodec.ts";
import {
  CODEC,
  type FabricCodec,
  type ReconstructionContext,
} from "@/wire-common/interface.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";
import { WIRE_TYPE_TAGS } from "@/wire-common/wire-type-tags.ts";

/**
 * Temporal type representing days from the POSIX Epoch (1970-01-01).
 * Wraps a `bigint` value. Used for date-only (no time) values.
 * See Section 1.4.7 of the formal spec.
 */
export class FabricEpochDays extends BaseFabricPrimitive
  implements ApiFabricEpochDays {
  /** Days from POSIX Epoch. Negative values represent pre-epoch dates. */
  readonly #value: bigint;

  constructor(value: bigint) {
    super();
    this.#value = value;
    Object.freeze(this);
  }

  /** Days from POSIX Epoch. Negative values represent pre-epoch dates. */
  get value(): bigint {
    return this.#value;
  }

  //
  // Static members
  //

  static #codec = Object.freeze(
    new (class EpochDaysCodec extends BaseFabricCodec {
      constructor() {
        super(WIRE_TYPE_TAGS.EpochDays, FabricEpochDays);
      }

      /** @inheritDoc */
      encode(value: FabricEpochDays): FabricValue {
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
            `EpochDays: expected string state, got ${typeof state}`,
          );
        }
        try {
          return new FabricEpochDays(
            bigintFromMinimalTwosComplement(fromBase64url(state)),
          );
        } catch {
          return new ProblematicValue(
            typeTag,
            state,
            `EpochDays: invalid base64: ${state}`,
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

// Compile-time check that the exported `FabricEpochDays` constructor matches the
// `FabricEpochDaysConstructor` declared in `@commonfabric/api`. This catches
// drift between the public type contract and this implementation.
FabricEpochDays satisfies ApiFabricEpochDaysConstructor;
