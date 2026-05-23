import type { FabricValue, ReconstructionContext } from "../interface.ts";
import { FabricEpochNsec } from "../fabric-primitives/FabricEpochNsec.ts";
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
import { makeProblematic } from "./make-problematic.ts";

/**
 * Handler for `FabricEpochNsec`. Serializes to a flat base64 string encoding
 * the underlying bigint's two's-complement big-endian byte representation.
 * Wire format: `{ "/EpochNsec@1": "<base64>" }`. `FabricEpochNsec` is a direct
 * member of `FabricValue` (not a `FabricInstance`), so this handler uses
 * `instanceof` directly.
 * See Section 5.3 of the formal spec.
 */
export const EpochNsecHandler: TypeHandler = {
  tag: TAGS.EpochNsec,

  canSerialize(value: FabricValue): boolean {
    return value instanceof FabricEpochNsec;
  },

  serialize(
    value: FabricValue,
    codec: TypeHandlerCodec,
    _recurse: (v: FabricValue) => JsonWireValue,
  ): JsonWireValue {
    const nsec = (value as FabricEpochNsec).value;
    const bytes = bigintToMinimalTwosComplement(nsec);
    const b64 = toUnpaddedBase64url(bytes);
    return codec.wrapTag(TAGS.EpochNsec, b64 as JsonWireValue);
  },

  deserialize(
    state: JsonWireValue,
    _runtime: ReconstructionContext,
    _recurse: (v: JsonWireValue) => FabricValue,
  ): FabricValue {
    if (typeof state !== "string") {
      return makeProblematic(
        TAGS.EpochNsec,
        state,
        `EpochNsec: expected string state, got ${typeof state}`,
      );
    }
    try {
      const bytes = fromBase64url(state);
      const bigint = bigintFromMinimalTwosComplement(bytes);
      return new FabricEpochNsec(bigint) as unknown as FabricValue;
    } catch {
      return makeProblematic(
        TAGS.EpochNsec,
        state,
        `EpochNsec: invalid base64: ${state}`,
      );
    }
  },
};
