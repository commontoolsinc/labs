import type {
  FabricEpochDays as ApiFabricEpochDays,
  FabricEpochDaysConstructor as ApiFabricEpochDaysConstructor,
} from "@commonfabric/api";
import {
  bigintFromUnpaddedBase64url,
  bigintToUnpaddedBase64url,
} from "@commonfabric/utils/bigint";

import type { FabricValue } from "@/interface.ts";
import { BaseFabricPrimitive } from "@/fabric-bases/BaseFabricPrimitive.ts";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import type { JsonCodecValue } from "@/codec-json/interface.ts";
import type { RealmCodecValue } from "@/codec-realm/interface.ts";
import {
  JSON_CODEC,
  type LiveEnvironment,
  REALM_CODEC,
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
        _env: LiveEnvironment,
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

  static #realmCodec = Object.freeze(
    new (class EpochDaysCodec extends BaseTerminalCodec<RealmCodecValue> {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.EpochDays, FabricEpochDays);
      }

      /** @inheritDoc */
      encode(value: FabricEpochDays): RealmCodecValue {
        return value.#value;
      }

      /**
       * @inheritDoc
       *
       * Reports a bad state by returning a `ProblematicValue`, as this
       * class's JSON codec does. The two ways a codec can reject -- this and
       * throwing -- are equivalent to a caller, the engine settling them
       * against `lenient`, so what decides between them is consistency across
       * the codecs a reader meets together.
       */
      decode(
        typeTag: string,
        state: RealmCodecValue,
        _env: LiveEnvironment,
      ): FabricValue {
        if (typeof state !== "bigint") {
          return new ProblematicValue(
            typeTag,
            state,
            `expected \`bigint\` state, got ${typeof state}`,
          );
        }

        return new FabricEpochDays(state);
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [JSON_CODEC](): TerminalCodec<JsonCodecValue> {
    return this.#jsonCodec;
  }

  /**
   * The codec for instances of this class in the realm-crossing format. The
   * `bigint` travels as itself, where JSON has to encode it as base64url text
   * over its two's-complement bytes.
   */
  static get [REALM_CODEC](): TerminalCodec<RealmCodecValue> {
    return this.#realmCodec;
  }
}

// Compile-time check that the exported `FabricEpochDays` constructor matches
// the `FabricEpochDaysConstructor` declared in `@commonfabric/api`. This
// catches drift between the public type contract and this implementation.
FabricEpochDays satisfies ApiFabricEpochDaysConstructor;
