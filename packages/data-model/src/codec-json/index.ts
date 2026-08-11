// Barrel for the JSON wire-format encoding area. This is the sole public entry
// point for the `codec-json` directory; the individual files are not exported
// directly via `deno.jsonc`.

// Public entry-point functions.
export { seemsLikeJsonEncodedFabricValue } from "./impl.ts";

// Registry factory for this format's primitive determination, and the codecs
// it registers. Each of the four exists because JSON cannot carry the type it
// handles, so each belongs to the format rather than to the shared machinery.
export { createBaseJsonRegistry } from "./createBaseJsonRegistry.ts";
export { BigIntCodec } from "./BigIntCodec.ts";
export { SpecialNumberCodec } from "./SpecialNumberCodec.ts";
export { SymbolCodec } from "./SymbolCodec.ts";
export { UndefinedCodec } from "./UndefinedCodec.ts";

// Whole-value codec for the wire format.
export { JsonCodec } from "./JsonCodec.ts";
