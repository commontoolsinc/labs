import type { FabricValue, ReconstructionContext } from "../interface.ts";
import { FabricEpochDays } from "../fabric-primitives/FabricEpochDays.ts";
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
} from "./interface.ts";
import { makeProblematic } from "./makeProblematic.ts";

/**
 * Handler for `FabricEpochDays`. Serializes to a flat base64 string encoding
 * the underlying bigint's two's-complement big-endian byte representation.
 * Wire format: `{ "/EpochDays@1": "<base64>" }`. `FabricEpochDays` is a direct
 * member of `FabricValue` (not a `FabricInstance`), so this handler uses
 * `instanceof` directly. Same flat encoding approach as `EpochNsecHandler`.
 * See Section 5.3 of the formal spec.
 */
export const EpochDaysHandler: TypeHandler = {
  tag: TAGS.EpochDays,

  canSerialize(value: FabricValue): boolean {
    return value instanceof FabricEpochDays;
  },

  serialize(
    value: FabricValue,
    codec: TypeHandlerCodec,
    _recurse: (v: FabricValue) => JsonWireValue,
  ): JsonWireValue {
    const days = (value as FabricEpochDays).value;
    const bytes = bigintToMinimalTwosComplement(days);
    const b64 = toUnpaddedBase64url(bytes);
    return codec.wrapTag(TAGS.EpochDays, b64 as JsonWireValue);
  },

  deserialize(
    state: JsonWireValue,
    _runtime: ReconstructionContext,
    _recurse: (v: JsonWireValue) => FabricValue,
  ): FabricValue {
    if (typeof state !== "string") {
      return makeProblematic(
        TAGS.EpochDays,
        state,
        `EpochDays: expected string state, got ${typeof state}`,
      );
    }
    try {
      const bytes = fromBase64url(state);
      const bigint = bigintFromMinimalTwosComplement(bytes);
      return new FabricEpochDays(bigint) as unknown as FabricValue;
    } catch {
      return makeProblematic(
        TAGS.EpochDays,
        state,
        `EpochDays: invalid base64: ${state}`,
      );
    }
  },
};
