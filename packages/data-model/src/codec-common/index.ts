export {
  CODEC,
  type FabricClassWithCodec,
  type FabricCodec,
  type ReconstructionContext,
  type SerializationContext,
} from "./interface.ts";

export { codecOf } from "./codecOf.ts";
export { CODEC_META_TAGS } from "./codec-meta-tags.ts";
export { CODEC_TYPE_TAGS } from "./codec-type-tags.ts";
export { BaseFabricCodec } from "./BaseFabricCodec.ts";
export { BaseReconstructionContext } from "./BaseReconstructionContext.ts";
export {
  EMPTY_RECONSTRUCTION_CONTEXT,
  EmptyReconstructionContext,
} from "./EmptyReconstructionContext.ts";
