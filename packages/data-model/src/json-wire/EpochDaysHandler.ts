import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/utils/base64url";
import {
  bigintFromMinimalTwosComplement,
  bigintToMinimalTwosComplement,
} from "@commonfabric/utils/bigint";

import type { FabricValue } from "@/interface.ts";
import { BaseFabricCodec } from "@/wire-common/BaseFabricCodec.ts";
import type { ReconstructionContext } from "@/wire-common/interface.ts";
import { FabricEpochDays } from "@/fabric-primitives/FabricEpochDays.ts";
import { WIRE_TYPE_TAGS } from "@/wire-common/wire-type-tags.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";

/**
 * Codec for `FabricEpochDays`. Encodes to a flat base64 string encoding the
 * underlying bigint's two's-complement big-endian byte representation. Wire
 * format: `{ "/EpochDays@1": "<base64>" }`. Matches by `instanceof`. Same flat
 * encoding approach as `EpochNsecHandler`. See Section 5.3 of the formal spec.
 */
export class EpochDaysHandler extends BaseFabricCodec {
  constructor() {
    super(WIRE_TYPE_TAGS.EpochDays, FabricEpochDays);
  }

  /** @inheritDoc */
  encode(value: FabricEpochDays): FabricValue {
    return toUnpaddedBase64url(bigintToMinimalTwosComplement(value.value));
  }

  /** @inheritDoc */
  decode(
    wireTypeTag: string,
    state: FabricValue,
    _context: ReconstructionContext,
  ): FabricValue {
    if (typeof state !== "string") {
      return new ProblematicValue(
        wireTypeTag,
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
        wireTypeTag,
        state,
        `EpochDays: invalid base64: ${state}`,
      );
    }
  }
}
