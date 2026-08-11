// Barrel for the shared codec machinery: the registry, the codec and
// reconstruction-context base classes, and the tag vocabularies.
//
// Everything here is format-agnostic and class-agnostic. Nothing in this
// directory knows which wire format is in play or which fabric classes exist:
// the only references to the value domain are `import type`, so there is no
// runtime dependency on a fabric class at all. A codec that exists because one
// particular format cannot carry some type belongs with that format instead --
// `codec-json/` holds the four that JSON needs.

export {
  CODEC,
  type DecomposingCodec,
  type FabricClassWithCodec,
  type FabricCodec,
  type MatchedCodec,
  type ReconstructionContext,
  type RegistrableCodec,
  type SerializationContext,
  type TerminalCodec,
} from "./interface.ts";

export { codecOf } from "./codecOf.ts";
export { CODEC_META_TAGS } from "./codec-meta-tags.ts";
export { CODEC_TYPE_TAGS } from "./codec-type-tags.ts";
export { BaseCodec } from "./BaseCodec.ts";
export { BaseDecomposingCodec } from "./BaseDecomposingCodec.ts";
export { BaseTerminalCodec } from "./BaseTerminalCodec.ts";
export { BaseReconstructionContext } from "./BaseReconstructionContext.ts";
export {
  EMPTY_RECONSTRUCTION_CONTEXT,
  EmptyReconstructionContext,
} from "./EmptyReconstructionContext.ts";

// Codec registry.
export { CodecRegistry } from "./CodecRegistry.ts";
