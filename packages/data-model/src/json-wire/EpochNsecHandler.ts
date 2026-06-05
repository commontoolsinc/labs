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
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import { WIRE_TYPE_TAGS } from "@/wire-common/wire-type-tags.ts";
import type {
  JsonWireValue,
  TypeHandler,
  TypeHandlerCodec,
} from "./interface.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";

/**
 * Handler for `FabricEpochNsec`. Serializes to a flat base64 string encoding
 * the underlying bigint's two's-complement big-endian byte representation.
 * Wire format: `{ "/EpochNsec@1": "<base64>" }`. Matches by `instanceof`.
 * See Section 5.3 of the formal spec.
 */
export const EpochNsecHandler: TypeHandler = {
  /** @inheritDoc */
  get classSource() {
    // Alas, this project doesn't let us just say the type "arbitrary function,"
    // and the cast here is the best we can do.
    return FabricEpochNsec as unknown as ((...args: any[]) => any);
  },

  /** @inheritDoc */
  get wireTypeTag() {
    return WIRE_TYPE_TAGS.EpochNsec;
  },

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
    return codec.wrapTag(WIRE_TYPE_TAGS.EpochNsec, b64 as JsonWireValue);
  },

  deserialize(
    state: JsonWireValue,
    _runtime: ReconstructionContext,
    _recurse: (v: JsonWireValue) => FabricValue,
  ): FabricValue {
    if (typeof state !== "string") {
      return new ProblematicValue(
        WIRE_TYPE_TAGS.EpochNsec,
        state,
        `EpochNsec: expected string state, got ${typeof state}`,
      );
    }
    try {
      const bytes = fromBase64url(state);
      const bigint = bigintFromMinimalTwosComplement(bytes);
      return new FabricEpochNsec(bigint) as unknown as FabricValue;
    } catch {
      return new ProblematicValue(
        WIRE_TYPE_TAGS.EpochNsec,
        state,
        `EpochNsec: invalid base64: ${state}`,
      );
    }
  },
};
