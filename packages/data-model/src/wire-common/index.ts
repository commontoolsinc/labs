export {
  CODEC,
  DECONSTRUCT,
  type FabricClassWithCodec,
  type FabricCodec,
  type FabricDeconstructable,
  type ReconstructionContext,
  type SerializationContext,
} from "./interface.ts";

export { codecOf } from "./codecOf.ts";
export { WIRE_META_TAGS } from "./wire-meta-tags.ts";
export { WIRE_TYPE_TAGS } from "./wire-type-tags.ts";
export { BaseFabricCodec } from "./BaseFabricCodec.ts";
export { BaseReconstructionContext } from "./BaseReconstructionContext.ts";
export {
  EMPTY_RECONSTRUCTION_CONTEXT,
  EmptyReconstructionContext,
} from "./EmptyReconstructionContext.ts";
