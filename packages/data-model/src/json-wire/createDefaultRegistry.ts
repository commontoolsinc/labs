import { CODEC } from "@/wire-common/interface.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import { FabricEpochDays } from "@/fabric-primitives/FabricEpochDays.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import { FabricMap } from "@/fabric-instances/FabricMap.ts";
import { FabricSet } from "@/fabric-instances/FabricSet.ts";

import { TypeHandlerRegistry } from "./TypeHandlerRegistry.ts";
import { BigIntHandler } from "./BigIntHandler.ts";
import { SpecialNumberHandler } from "./SpecialNumberHandler.ts";
import { SymbolHandler } from "./SymbolHandler.ts";
import { UndefinedHandler } from "./UndefinedHandler.ts";

/**
 * Creates a registry with the built-in codecs. Each fabric class that has a
 * fixed wire tag supplies its own codec via the static `[CODEC]` getter; the
 * four JS-primitive codecs (`bigint`, special `number`, interned `symbol`,
 * `undefined`) have no class to host a `[CODEC]`, so they are registered as
 * standalone codec instances.
 *
 * `null`, `boolean`, finite `number`, `string`, arrays, and plain objects are
 * handled as fallthrough in the serializer after no codec matches.
 *
 * Generic `FabricInstance` values are handled per-type by their `[CODEC]`s
 * (above); there is no catch-all instance handler. `ExplicitTagValue` /
 * `UnknownValue` / `ProblematicValue` are live-graph stand-ins that carry a
 * per-instance tag and are handled directly by the encoding context.
 */
export function createDefaultRegistry(): TypeHandlerRegistry {
  const registry = new TypeHandlerRegistry();

  // Fabric classes with a fixed wire tag: codec lives on the class.
  registry.register(FabricBytes[CODEC]);
  registry.register(FabricEpochNsec[CODEC]);
  registry.register(FabricEpochDays[CODEC]);
  registry.register(FabricRegExp[CODEC]);
  registry.register(FabricError[CODEC]);
  registry.register(FabricMap[CODEC]);
  registry.register(FabricSet[CODEC]);

  // JS primitives that need tagged encoding (no owned class to host a codec).
  registry.register(new BigIntHandler());
  registry.register(new SpecialNumberHandler());
  registry.register(new SymbolHandler());
  registry.register(new UndefinedHandler());

  return registry;
}
