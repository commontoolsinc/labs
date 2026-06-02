import { TypeHandlerRegistry } from "./TypeHandlerRegistry.ts";
import { UndefinedHandler } from "./UndefinedHandler.ts";
import { BigIntHandler } from "./BigIntHandler.ts";
import { EpochNsecHandler } from "./EpochNsecHandler.ts";
import { EpochDaysHandler } from "./EpochDaysHandler.ts";
import { SpecialNumberHandler } from "./SpecialNumberHandler.ts";
import { SymbolHandler } from "./SymbolHandler.ts";
import { BytesHandler } from "./BytesHandler.ts";
import { RegExpHandler } from "./RegExpHandler.ts";
import { FabricInstanceHandler } from "./FabricInstanceHandler.ts";

/**
 * Creates a registry with the built-in type handlers. The order matters for
 * serialization: `FabricPrimitive` subclasses are checked first (direct
 * `FabricValue` members matched by `instanceof`), then `FabricInstance`
 * (generic protocol types), then `bigint` and `undefined`. Primitives
 * (`null`, `boolean`, `number`, `string`), arrays, and plain objects are
 * handled as fallthrough in the serializer after no handler matches.
 */
export function createDefaultRegistry(): TypeHandlerRegistry {
  const registry = new TypeHandlerRegistry();
  // `FabricPrimitive` subclasses first -- they are direct `FabricValue` members
  // matched by `instanceof`, and must be checked before the generic
  // `FabricInstanceHandler`.
  registry.register(EpochNsecHandler);
  registry.register(EpochDaysHandler);
  registry.register(BytesHandler);
  registry.register(RegExpHandler);
  // `FabricInstance` (generic -- checked via `instanceof`).
  registry.register(FabricInstanceHandler);
  // Primitives that need tagged encoding (can't be expressed in JSON natively).
  registry.register(BigIntHandler);
  registry.register(SpecialNumberHandler);
  registry.register(SymbolHandler);
  registry.register(UndefinedHandler);
  return registry;
}
