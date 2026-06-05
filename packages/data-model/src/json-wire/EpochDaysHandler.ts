import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/utils/base64url";
import {
  bigintFromMinimalTwosComplement,
  bigintToMinimalTwosComplement,
} from "@commonfabric/utils/bigint";

import type { FabricValue } from "@/interface.ts";
import type { ReconstructionContext } from "@/wire-common/interface.ts";
import { FabricEpochDays } from "@/fabric-primitives/FabricEpochDays.ts";
import { WIRE_TYPE_TAGS } from "@/wire-common/wire-type-tags.ts";
import type { JsonWireValue, TagHandler, TypeHandler } from "./interface.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";

/**
 * Handler for `FabricEpochDays`. Serializes to a flat base64 string encoding
 * the underlying bigint's two's-complement big-endian byte representation.
 * Wire format: `{ "/EpochDays@1": "<base64>" }`. Matches by `instanceof`.
 * Same flat encoding approach as `EpochNsecHandler`.
 * See Section 5.3 of the formal spec.
 */
export const EpochDaysHandler: TypeHandler = {
  /** @inheritDoc */
  get classSource() {
    // Alas, this project doesn't let us just say the type "arbitrary function,"
    // and the cast here is the best we can do.
    return FabricEpochDays as unknown as ((...args: any[]) => any);
  },

  /** @inheritDoc */
  get wireTypeTag() {
    return WIRE_TYPE_TAGS.EpochDays;
  },

  canSerialize(value: FabricValue): boolean {
    return value instanceof FabricEpochDays;
  },

  serialize(
    value: FabricValue,
    tagHandler: TagHandler,
    _recurse: (v: FabricValue) => JsonWireValue,
  ): JsonWireValue {
    const days = (value as FabricEpochDays).value;
    const bytes = bigintToMinimalTwosComplement(days);
    const b64 = toUnpaddedBase64url(bytes);
    return tagHandler.wrapTag(WIRE_TYPE_TAGS.EpochDays, b64 as JsonWireValue);
  },

  deserialize(
    state: JsonWireValue,
    _runtime: ReconstructionContext,
    _recurse: (v: JsonWireValue) => FabricValue,
  ): FabricValue {
    if (typeof state !== "string") {
      return new ProblematicValue(
        WIRE_TYPE_TAGS.EpochDays,
        state,
        `EpochDays: expected string state, got ${typeof state}`,
      );
    }
    try {
      const bytes = fromBase64url(state);
      const bigint = bigintFromMinimalTwosComplement(bytes);
      return new FabricEpochDays(bigint) as unknown as FabricValue;
    } catch {
      return new ProblematicValue(
        WIRE_TYPE_TAGS.EpochDays,
        state,
        `EpochDays: invalid base64: ${state}`,
      );
    }
  },
};
