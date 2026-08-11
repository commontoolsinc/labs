import type { FabricValue } from "@/interface.ts";
import type { DecomposingCodec, ReconstructionContext } from "./interface.ts";
import { BaseCodecDispatch } from "./BaseCodecDispatch.ts";

/**
 * Base class for `DecomposingCodec` which provides commonly-needed
 * functionality. A subclass's state is made of fabric values that the walker
 * encodes in turn, so one instance serves every wire format.
 */
export abstract class BaseFabricCodec extends BaseCodecDispatch
  implements DecomposingCodec {
  /** @inheritDoc */
  abstract decode(
    typeTag: string,
    state: FabricValue,
    context: ReconstructionContext,
  ): FabricValue;

  /** @inheritDoc */
  abstract encode(value: FabricValue): FabricValue;
}
