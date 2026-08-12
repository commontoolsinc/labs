// Barrel for the codec system's declarations: the interfaces a codec and a
// reconstruction context satisfy, the abstract bases that classify a codec as
// terminal or nonterminal, and the tag vocabularies.
//
// Nothing here does any codec work. What lives in this directory says what a
// codec IS -- its shape, its kind, the names it may use -- while the machinery
// that acts on those declarations lives in `codec-common/`, alongside the
// registry that indexes them and the abstract classes a participating value
// extends.
//
// This directory imports no runtime value from anywhere else in the package,
// which is what makes it reachable from any module without regard to layering.
// A module needing only to name a codec imports the file it wants from here
// and pulls none of the machinery in behind it.

export {
  CODEC,
  type CodecForFormat,
  type FabricClassWithNonterminalCodec,
  type FabricCodec,
  type NonterminalCodec,
  type ReconstructionContext,
  type SerializationContext,
  type TerminalCodec,
  type WireFormat,
} from "./interface.ts";

export { CODEC_META_TAGS } from "./codec-meta-tags.ts";
export { CODEC_TYPE_TAGS } from "./codec-type-tags.ts";

export { BaseFabricCodec } from "./BaseFabricCodec.ts";
export { BaseNonterminalCodec } from "./BaseNonterminalCodec.ts";
export { BaseTerminalCodec } from "./BaseTerminalCodec.ts";

export { BaseReconstructionContext } from "./BaseReconstructionContext.ts";
export {
  EMPTY_RECONSTRUCTION_CONTEXT,
  EmptyReconstructionContext,
} from "./EmptyReconstructionContext.ts";
