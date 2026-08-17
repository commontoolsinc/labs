export {
  CODEC,
  type CodecForFormat,
  type DecodeContext,
  type EncodeContext,
  type FabricClassWithNonterminalCodec,
  type FabricCodec,
  JSON_CODEC,
  type NonterminalCodec,
  type TerminalCodec,
  type WireFormat,
} from "./interface.ts";

export { CODEC_META_TAGS } from "./codec-meta-tags.ts";
export { CODEC_TYPE_TAGS } from "./codec-type-tags.ts";

export { BaseFabricCodec } from "./BaseFabricCodec.ts";
export { BaseNonterminalCodec } from "./BaseNonterminalCodec.ts";
export { BaseTerminalCodec } from "./BaseTerminalCodec.ts";

export { BaseDecodeContext } from "./BaseDecodeContext.ts";
export {
  EMPTY_DECODE_CONTEXT,
  EmptyDecodeContext,
} from "./EmptyDecodeContext.ts";
