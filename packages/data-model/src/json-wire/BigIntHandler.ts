import type { FabricValue, ReconstructionContext } from "../interface.ts";
import { WIRE_TYPE_TAGS } from "../wire-common/wire-type-tags.ts";
import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/utils/base64url";
import {
  bigintFromMinimalTwosComplement,
  bigintToMinimalTwosComplement,
} from "@commonfabric/utils/bigint";
import type {
  JsonWireValue,
  TypeHandler,
  TypeHandlerCodec,
} from "./interface.ts";
import { ProblematicValue } from "../fabric-instances/ProblematicValue.ts";

/**
 * Handler for `bigint`. Serializes to `WIRE_TYPE_TAGS.BigInt` tag with an
 * unpadded base64 string encoding the bigint's two's-complement big-endian byte
 * representation. Wire format: `{ "/BigInt@1": "<base64>" }`.
 *
 * The byte encoding is the same one used by the hash (Section 3.7 of the
 * byte-level spec): minimal two's-complement big-endian, with sign extension
 * as needed.
 */
export const BigIntHandler: TypeHandler = {
  /** @inheritDoc */
  get classSource() {
    return BigInt;
  },

  /** @inheritDoc */
  get wireTypeTag() {
    return WIRE_TYPE_TAGS.BigInt;
  },

  canSerialize(value: FabricValue): boolean {
    return typeof value === "bigint";
  },

  serialize(
    value: FabricValue,
    codec: TypeHandlerCodec,
    _recurse: (v: FabricValue) => JsonWireValue,
  ): JsonWireValue {
    const bytes = bigintToMinimalTwosComplement(value as bigint);
    const b64 = toUnpaddedBase64url(bytes);
    return codec.wrapTag(WIRE_TYPE_TAGS.BigInt, b64 as JsonWireValue);
  },

  deserialize(
    state: JsonWireValue,
    _runtime: ReconstructionContext,
    _recurse: (v: JsonWireValue) => FabricValue,
  ): FabricValue {
    if (typeof state !== "string") {
      return new ProblematicValue(
        WIRE_TYPE_TAGS.BigInt,
        state,
        `bigint: expected string state, got ${typeof state}`,
      );
    }
    try {
      const bytes = fromBase64url(state);
      return bigintFromMinimalTwosComplement(bytes);
    } catch {
      return new ProblematicValue(
        WIRE_TYPE_TAGS.BigInt,
        state,
        `bigint: invalid base64: ${state}`,
      );
    }
  },
};
