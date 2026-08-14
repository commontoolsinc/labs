// Public entry-point functions.
export { seemsLikeJsonEncodedFabricValue } from "./impl.ts";

// Registry factory for this format's primitive determination, and the codecs
// it registers. Each of the three exists because JSON cannot carry the type it
// handles AND represents it in a way JSON picked: base64url text for a
// `bigint`, one of four literal strings for a special number, `null` for
// `undefined`. A symbol meets the first condition and not the second -- its
// portable content is a registry key, which is a string in any format -- so
// `SymbolCodec` is shared machinery instead of living here.
export { createBaseJsonRegistry } from "./createBaseJsonRegistry.ts";
export { BigIntCodec } from "./BigIntCodec.ts";
export { SpecialNumberCodec } from "./SpecialNumberCodec.ts";
export { UndefinedCodec } from "./UndefinedCodec.ts";

// Whole-value codec for the wire format.
export { JsonCodecEngine } from "./JsonCodecEngine.ts";
