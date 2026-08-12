/**
 * This directory holds everything specific to the JSON wire format: the
 * whole-value codec, the codecs for the four types JSON cannot carry, and the
 * registry factory that puts them together. This file is its sole public entry
 * point; the individual files are not exported via `deno.jsonc`.
 */

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
