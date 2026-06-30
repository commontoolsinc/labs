// Barrel for the JSON wire-format encoding area. This is the sole public entry
// point for the `codec-json` directory; the individual files are not exported
// directly via `deno.jsonc`.

// Public entry-point functions.
export {
  jsonFromValue,
  plainObjectFromJson,
  seemsLikeJsonEncodedFabricValue,
  valueFromJson,
} from "./json-encoding.ts";

// Encoding context.
export { JsonEncodingContext } from "./JsonEncodingContext.ts";

// Shared wire-format vocabulary.
export type { JsonWireValue } from "./interface.ts";

// Codec registry and factory.
export { CodecRegistry } from "./CodecRegistry.ts";
export { createDefaultRegistry } from "./createDefaultRegistry.ts";
