import { BaseFabricCodec } from "./BaseFabricCodec.ts";
import { CODEC_TYPE_TAGS } from "./codec-type-tags.ts";
import type { ReconstructionContext } from "./interface.ts";

import {
  createFactoryShell,
  isAdmittedFabricFactory,
  sealFactoryState,
} from "@/fabric-factory.ts";
import type { FabricValue } from "@/interface.ts";
import { deepFreeze } from "@/deep-freeze.ts";

/** Codec for directly callable, serializable Fabric factories. */
export class FactoryCodec extends BaseFabricCodec {
  constructor() {
    super(CODEC_TYPE_TAGS.Factory, undefined);
  }

  override canEncode(value: FabricValue): boolean {
    return isAdmittedFabricFactory(value);
  }

  override encode(value: FabricValue): FabricValue {
    return sealFactoryState(value, deepFreeze) as FabricValue;
  }

  override decode(
    _typeTag: string,
    state: FabricValue,
    _context: ReconstructionContext,
  ): FabricValue {
    return createFactoryShell(state, deepFreeze) as FabricValue;
  }
}
