import { BigIntCodec } from "@/codec-common/BigIntCodec.ts";
import { SpecialNumberCodec } from "@/codec-common/SpecialNumberCodec.ts";
import { SymbolCodec } from "@/codec-common/SymbolCodec.ts";
import { UndefinedCodec } from "@/codec-common/UndefinedCodec.ts";
import { CodecRegistry } from "@/codec-common/CodecRegistry.ts";

/**
 * Creates a registry holding this format's determination about JavaScript's
 * primitive types, and nothing else. It registers no fabric class, so a
 * registry from here encodes no `FabricSpecialObject` and decodes every fabric
 * wire tag to an `UnknownValue`; registering the classes that participate is a
 * caller's job.
 *
 * Two groups, which is the whole of what the JSON format decides:
 *
 * * The self-representing types (`null`, `boolean`, finite `number`, `string`)
 *   go through `registerSelfRep()`, each being its own JSON form, so that
 *   `codecFromValue()` reports them directly. Arrays and plain objects are
 *   likewise handled structurally by the serializer once no codec matches.
 * * The four types JSON cannot carry (`bigint`, special `number`, interned
 *   `symbol`, `undefined`) get a tagged encoding. None has an owned class to
 *   host a `[CODEC]`, so each is registered by `typeof` through
 *   `registerPrimitive()`, for O(1) encode dispatch.
 *
 * Another wire format makes different choices here, which is what separates
 * this from the class rosters it gets combined with: those stay the same
 * whatever the format.
 */
export function createBaseJsonRegistry(): CodecRegistry {
  const registry = new CodecRegistry();

  // JS primitives that need tagged encoding, registered by `typeof`.
  registry.registerPrimitive("bigint", new BigIntCodec());
  registry.registerPrimitive("number", new SpecialNumberCodec());
  registry.registerPrimitive("symbol", new SymbolCodec());
  registry.registerPrimitive("undefined", new UndefinedCodec());

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
