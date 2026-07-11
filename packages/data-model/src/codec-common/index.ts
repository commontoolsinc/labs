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

// Standalone codecs for JS primitives (no owned class to host a `[CODEC]`).
export { UndefinedCodec } from "./UndefinedCodec.ts";
export { BigIntCodec } from "./BigIntCodec.ts";
export { SpecialNumberCodec } from "./SpecialNumberCodec.ts";
export { SymbolCodec } from "./SymbolCodec.ts";
export { FactoryCodec } from "./FactoryCodec.ts";
