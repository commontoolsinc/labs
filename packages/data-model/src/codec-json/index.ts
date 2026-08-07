// Barrel for the JSON wire-format encoding area. This is the sole public entry
// point for the `codec-json` directory; the individual files are not exported
// directly via `deno.jsonc`.

// Public entry-point functions.
export {
  jsonFromValue,
  plainObjectFromJson,
  seemsLikeJsonEncodedFabricValue,
  valueFromJson,
} from "./impl.ts";

// Whole-value codec for the wire format.
export { JsonCodec } from "./JsonCodec.ts";

// Shared wire-format vocabulary.
export type { JsonWireValue } from "./interface.ts";
