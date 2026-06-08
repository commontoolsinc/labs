import { CODEC } from "@/wire-common/interface.ts";
import { codecClasses as primitiveCodecClasses } from "@/fabric-primitives/index.ts";
import { codecClasses as instanceCodecClasses } from "@/fabric-instances/index.ts";

import { CodecRegistry } from "./CodecRegistry.ts";
import { BigIntCodec } from "./BigIntCodec.ts";
import { SpecialNumberCodec } from "./SpecialNumberCodec.ts";
import { SymbolCodec } from "./SymbolCodec.ts";
import { UndefinedCodec } from "./UndefinedCodec.ts";

/**
 * Creates a registry with the built-in codecs. Fabric classes whose instances
 * have a fixed wire tag supply their codec via a static `[CODEC]`; the curated
 * `codecClasses()` list from each of `fabric-primitives` and `fabric-instances`
 * is the source of truth for which classes participate, so the wire-format
 * surface is curated there rather than by the imports here. The four
 * JS-primitive codecs (`bigint`, special `number`, interned `symbol`,
 * `undefined`) have no owned class and are registered as standalone codecs.
 *
 * `null`, `boolean`, finite `number`, `string`, arrays, and plain objects are
 * handled as fallthrough in the serializer after no codec matches.
 *
 * `ExplicitTagValue` / `UnknownValue` / `ProblematicValue` are live-graph
 * stand-ins that carry a per-instance tag and are handled directly by the
 * encoding context, so they are not registered here.
 */
export function createDefaultRegistry(): CodecRegistry {
  const registry = new CodecRegistry();

  // Codecs that live on a fabric class (primitives first, then instances).
  for (const cls of primitiveCodecClasses()) {
    registry.register(cls[CODEC]);
  }
  for (const cls of instanceCodecClasses()) {
    registry.register(cls[CODEC]);
  }

  // JS primitives that need tagged encoding (no owned class to host a codec).
  registry.register(new BigIntCodec());
  registry.register(new SpecialNumberCodec());
  registry.register(new SymbolCodec());
  registry.register(new UndefinedCodec());

  return registry;
}
