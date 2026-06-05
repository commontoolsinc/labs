import type { FabricValue } from "@/interface.ts";
import { BaseFabricCodec } from "@/wire-common/BaseFabricCodec.ts";
import type { ReconstructionContext } from "@/wire-common/interface.ts";
import { WIRE_TYPE_TAGS } from "@/wire-common/wire-type-tags.ts";

/**
 * Codec for `undefined`. Encodes to the `Undefined@1` tag with `null` state.
 * `undefined` has no corresponding class, so there is no `uniqueHandledClass`;
 * matching is by `canEncode()`. See Section 1.4.1 of the formal spec.
 */
export class UndefinedHandler extends BaseFabricCodec {
  constructor() {
    super(WIRE_TYPE_TAGS.Undefined, undefined);
  }

  /** @inheritDoc */
  override canEncode(value: FabricValue): boolean {
    return value === undefined;
  }

  /** @inheritDoc */
  encode(_value: FabricValue): FabricValue {
    return null;
  }

  /** @inheritDoc */
  decode(
    _wireTypeTag: string,
    _state: FabricValue,
    _context: ReconstructionContext,
  ): FabricValue {
    return undefined;
  }
}
