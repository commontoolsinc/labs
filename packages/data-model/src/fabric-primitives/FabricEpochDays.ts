import type {
  FabricEpochDays as ApiFabricEpochDays,
  FabricEpochDaysConstructor as ApiFabricEpochDaysConstructor,
} from "@commonfabric/api";
import {
  bigintFromUnpaddedBase64url,
  bigintToUnpaddedBase64url,
} from "@commonfabric/utils/bigint";

import type { FabricValue } from "@/interface.ts";
import { BaseFabricPrimitive } from "@/codec-common/BaseFabricPrimitive.ts";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import type { JsonCodecValue } from "@/codec-json/interface.ts";
import {
  JSON_CODEC,
  type LiveEnvironment,
  type TerminalCodec,
} from "@/codec-interface/interface.ts";
import { ProblematicValue } from "@/codec-common/ProblematicValue.ts";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";

/**
 * Temporal type representing days from the POSIX Epoch (1970-01-01).
 * Wraps a `bigint` value. Used for date-only (no time) values.
 * See Section 1.4.7 of the formal spec.
 */
export class FabricEpochDays extends BaseFabricPrimitive
  implements ApiFabricEpochDays {
  /** Days from POSIX Epoch. Negative values represent pre-epoch dates. */
  readonly #value: bigint;

  /** Constructs an instance representing `value` days from the Epoch. */
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

  static #jsonCodec = Object.freeze(
    new (class EpochDaysCodec extends BaseTerminalCodec<JsonCodecValue> {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.EpochDays, FabricEpochDays);
      }

      /** @inheritDoc */
      encode(value: FabricEpochDays): JsonCodecValue {
        return bigintToUnpaddedBase64url(value.#value);
      }

      /** @inheritDoc */
      decode(
        typeTag: string,
        state: JsonCodecValue,
        _context: LiveEnvironment,
      ): FabricValue {
        if (typeof state !== "string") {
          return new ProblematicValue(
            typeTag,
            state,
            `EpochDays: expected string state, got ${typeof state}`,
          );
        }
        try {
          return new FabricEpochDays(bigintFromUnpaddedBase64url(state));
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
  static get [JSON_CODEC](): TerminalCodec<JsonCodecValue> {
    return this.#jsonCodec;
  }
}

// Compile-time check that the exported `FabricEpochDays` constructor matches
// the `FabricEpochDaysConstructor` declared in `@commonfabric/api`. This
// catches drift between the public type contract and this implementation.
FabricEpochDays satisfies ApiFabricEpochDaysConstructor;
