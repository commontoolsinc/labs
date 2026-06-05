import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/utils/base64url";

import type { FabricValue } from "@/interface.ts";
import {
  BaseFabricCodec,
} from "@/wire-common/BaseFabricCodec.ts";
import type { ReconstructionContext } from "@/wire-common/interface.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { WIRE_TYPE_TAGS } from "@/wire-common/wire-type-tags.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";

/**
 * Codec for `FabricBytes`. Encodes to a flat base64url string encoding the raw
 * bytes. Wire format: `{ "/Bytes@1": "<base64>" }`. Matches by `instanceof`.
 */
export class BytesHandler extends BaseFabricCodec {
  constructor() {
    super(WIRE_TYPE_TAGS.Bytes, FabricBytes);
  }

  /** @inheritDoc */
  encode(value: FabricBytes): FabricValue {
    return toUnpaddedBase64url(value.slice());
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
        `Bytes: expected string state, got ${typeof state}`,
      );
    }
    try {
      return new FabricBytes(fromBase64url(state));
    } catch {
      return new ProblematicValue(
        wireTypeTag,
        state,
        `Bytes: invalid base64: ${state}`,
      );
    }
  }
}
