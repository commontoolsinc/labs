import type { FabricValue, ReconstructionContext } from "../interface.ts";
import { TAGS } from "../fabric-type-tags.ts";
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
} from "./json-wire-types.ts";
import { makeProblematic } from "./makeProblematic.ts";

/**
 * Handler for `bigint`. Serializes to `TAGS.BigInt` tag with an unpadded
 * base64 string encoding the bigint's two's-complement big-endian byte
 * representation. Wire format: `{ "/BigInt@1": "<base64>" }`.
 *
 * The byte encoding is the same one used by the hash (Section 3.7 of the
 * byte-level spec): minimal two's-complement big-endian, with sign extension
 * as needed.
 */
export const BigIntHandler: TypeHandler = {
  tag: TAGS.BigInt,

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
    return codec.wrapTag(TAGS.BigInt, b64 as JsonWireValue);
  },

  deserialize(
    state: JsonWireValue,
    _runtime: ReconstructionContext,
    _recurse: (v: JsonWireValue) => FabricValue,
  ): FabricValue {
    if (typeof state !== "string") {
      return makeProblematic(
        TAGS.BigInt,
        state,
        `bigint: expected string state, got ${typeof state}`,
      );
    }
    try {
      const bytes = fromBase64url(state);
      return bigintFromMinimalTwosComplement(bytes);
    } catch {
      return makeProblematic(
        TAGS.BigInt,
        state,
        `bigint: invalid base64: ${state}`,
      );
    }
  },
};
