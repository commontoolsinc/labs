import { CODEC } from "@/codec-common/interface.ts";
import { BigIntCodec } from "@/codec-common/BigIntCodec.ts";
import { SpecialNumberCodec } from "@/codec-common/SpecialNumberCodec.ts";
import { SymbolCodec } from "@/codec-common/SymbolCodec.ts";
import { UndefinedCodec } from "@/codec-common/UndefinedCodec.ts";
import { FactoryCodec } from "@/codec-common/FactoryCodec.ts";
import { codecClasses as primitiveCodecClasses } from "@/fabric-primitives/index.ts";
import { codecClasses as instanceCodecClasses } from "@/fabric-instances/index.ts";

import { CodecRegistry } from "./CodecRegistry.ts";

/**
 * Creates a registry with the built-in codecs. Fabric classes whose instances
 * have a fixed wire tag supply their codec via a static `[CODEC]`; the curated
 * `codecClasses()` list from each of `fabric-primitives` and `fabric-instances`
 * is the source of truth for which classes participate, so the wire-format
 * surface is curated there rather than by the imports here. The four
 * JS-primitive codecs (`bigint`, special `number`, interned `symbol`,
 * `undefined`) have no owned class and are registered by `typeof` via
 * `registerPrimitive()`.
 *
 * The self-representing primitive types (`null`, `boolean`, finite `number`,
 * `string`) are registered via `registerSelfRep()`, so `codecFromValue()`
 * reports them directly; arrays and plain objects are handled structurally by
 * the serializer after no codec matches.
 *
 * Directly callable factories use a separate callable slot. They do not join
 * the primitive or class registries, so ordinary functions remain invalid.
 *
 * `UnknownValue` / `ProblematicValue` are registered (via `instanceCodecClasses`)
 * but their codecs recognize no single wire tag: the encode path resolves each
 * instance's tag with `tagForValue()`, and an unrecognized tag on decode is
 * wrapped in an `UnknownValue` by the encoding context rather than tag-routed.
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

  // JS primitives that need tagged encoding (no owned class to host a codec),
  // registered by `typeof` for O(1) encode dispatch.
  registry.registerPrimitive("bigint", new BigIntCodec());
  registry.registerPrimitive("number", new SpecialNumberCodec());
  registry.registerPrimitive("symbol", new SymbolCodec());
  registry.registerPrimitive("undefined", new UndefinedCodec());

  // Callable factories have a dedicated slot. They are neither primitives nor
  // class-dispatched objects, and arbitrary functions remain unencodable.
  registry.registerCallable(new FactoryCodec());

  // Self-representing primitives: emitted as-is (their own wire form).
  // `number` is registered both ways -- finite numbers self-represent, while
  // `-0` / `NaN` / `±Infinity` go through the SpecialNumber codec above (which
  // `codecFromValue()` tries first).
  registry.registerSelfRep("null");
  registry.registerSelfRep("boolean");
  registry.registerSelfRep("number");
  registry.registerSelfRep("string");

  return registry;
}
