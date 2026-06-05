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
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import { WIRE_TYPE_TAGS } from "@/wire-common/wire-type-tags.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";

/**
 * Codec for `FabricEpochNsec`. Encodes to a flat base64 string encoding the
 * underlying bigint's two's-complement big-endian byte representation. Wire
 * format: `{ "/EpochNsec@1": "<base64>" }`. Matches by `instanceof`.
 * See Section 5.3 of the formal spec.
 */
export class EpochNsecHandler extends BaseFabricCodec {
  constructor() {
    super(WIRE_TYPE_TAGS.EpochNsec, FabricEpochNsec);
  }

  /** @inheritDoc */
  encode(value: FabricEpochNsec): FabricValue {
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
        `EpochNsec: expected string state, got ${typeof state}`,
      );
    }
    try {
      return new FabricEpochNsec(
        bigintFromMinimalTwosComplement(fromBase64url(state)),
      );
    } catch {
      return new ProblematicValue(
        wireTypeTag,
        state,
        `EpochNsec: invalid base64: ${state}`,
      );
    }
  }
}
