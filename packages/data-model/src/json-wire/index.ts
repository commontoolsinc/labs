// Barrel for the JSON wire-format encoding area. This is the sole public entry
// point for the `json-wire` directory; the individual files are not exported
// directly via `deno.json`.

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
export type {
  JsonWireValue,
  TypeHandler,
  TypeHandlerCodec,
} from "./interface.ts";

// Type handler registry and factory.
export { TypeHandlerRegistry } from "./TypeHandlerRegistry.ts";
export { createDefaultRegistry } from "./createDefaultRegistry.ts";

// Built-in type handlers.
export { UndefinedHandler } from "./UndefinedHandler.ts";
export { BigIntHandler } from "./BigIntHandler.ts";
export { EpochNsecHandler } from "./EpochNsecHandler.ts";
export { EpochDaysHandler } from "./EpochDaysHandler.ts";
export { SpecialNumberHandler } from "./SpecialNumberHandler.ts";
export { SymbolHandler } from "./SymbolHandler.ts";
export { BytesHandler } from "./BytesHandler.ts";
export { RegExpHandler } from "./RegExpHandler.ts";
export { FabricInstanceHandler } from "./FabricInstanceHandler.ts";
