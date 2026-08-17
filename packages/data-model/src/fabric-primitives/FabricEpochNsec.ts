import type {
  FabricEpochNsec as ApiFabricEpochNsec,
  FabricEpochNsecConstructor as ApiFabricEpochNsecConstructor,
} from "@commonfabric/api";
import {
  bigintFromUnpaddedBase64url,
  bigintToUnpaddedBase64url,
} from "@commonfabric/utils/bigint";

import type { FabricValue } from "@/interface.ts";
import { BaseFabricPrimitive } from "@/codec-common/BaseFabricPrimitive.ts";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import type { JsonCodecValue } from "@/codec-json/interface.ts";
import type { RealmCodecValue } from "@/codec-realm/interface.ts";
import {
  JSON_CODEC,
  REALM_CODEC,
  type DecodeContext,
  type TerminalCodec,
} from "@/codec-interface/interface.ts";
import { ProblematicValue } from "@/codec-common/ProblematicValue.ts";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";

/**
 * Temporal type representing nanoseconds from the POSIX Epoch
 * (1970-01-01T00:00:00Z). Wraps a `bigint` value. Used for high-precision
 * timestamps. See Section 1.4.6 of the formal spec.
 */
export class FabricEpochNsec extends BaseFabricPrimitive
  implements ApiFabricEpochNsec {
  /**
   * Nanoseconds from the POSIX Epoch. A negative value represents a pre-epoch
   * timestamp.
   */
  readonly #value: bigint;

  /** Constructs an instance representing `value` nanoseconds from the Epoch. */
  constructor(value: bigint) {
    super();
    this.#value = value;
    Object.freeze(this);
  }

  /**
   * Nanoseconds from the POSIX Epoch. A negative value represents a pre-epoch
   * timestamp.
   */
  get value(): bigint {
    return this.#value;
  }

  //
  // Static members
  //

  static #jsonCodec = Object.freeze(
    new (class EpochNsecCodec extends BaseTerminalCodec<JsonCodecValue> {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.EpochNsec, FabricEpochNsec);
      }

      /** @inheritDoc */
      encode(value: FabricEpochNsec): JsonCodecValue {
        return bigintToUnpaddedBase64url(value.#value);
      }

      /** @inheritDoc */
      decode(
        typeTag: string,
        state: JsonCodecValue,
        _context: DecodeContext,
      ): FabricValue {
        if (typeof state !== "string") {
          return new ProblematicValue(
            typeTag,
            state,
            `EpochNsec: expected string state, got ${typeof state}`,
          );
        }
        try {
          return new FabricEpochNsec(bigintFromUnpaddedBase64url(state));
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

  static #realmCodec = Object.freeze(
    new (class EpochNsecCodec extends BaseTerminalCodec<RealmCodecValue> {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.EpochNsec, FabricEpochNsec);
      }

      /** @inheritDoc */
      encode(value: FabricEpochNsec): RealmCodecValue {
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
        _context: DecodeContext,
      ): FabricValue {
        if (typeof state !== "bigint") {
          return new ProblematicValue(
            typeTag,
            state,
            `expected \`bigint\` state, got ${typeof state}`,
          );
        }

        return new FabricEpochNsec(state);
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

// Compile-time check that the exported `FabricEpochNsec` constructor matches
// the `FabricEpochNsecConstructor` declared in `@commonfabric/api`. This
// catches drift between the public type contract and this implementation.
FabricEpochNsec satisfies ApiFabricEpochNsecConstructor;
