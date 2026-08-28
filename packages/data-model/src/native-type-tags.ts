/**
 * Answering what a JS value already is, so that conversion can decide what to
 * make of it. These tags name the value's own class, and are unrelated to the
 * tags a wire format writes, which say what it became.
 *
 * The question is harder than an `instanceof` because the answer must not be
 * forgeable, and must still be reachable for a value that did not come from
 * here. A class is read off the prototype rather than off the value, since an
 * own `constructor` property is ordinary data that would otherwise let a plain
 * record present itself as an `Error`. A value from another realm, or one
 * whose prototype has been severed, has to be recognized regardless, which is
 * why the constructor switch has fallbacks beneath it rather than standing
 * alone.
 *
 * This module is the dispatch that knows every class the system has, fabric
 * ones included, and so is layered above them. `native-builtin-tags.ts` is the
 * dispatch a module layered below them asks instead, and `native-tags.ts` holds
 * what the two share. Both are re-exported here, so that a caller with no
 * interest in the split sees one module.
 */

import { FabricEpochDay } from "@/fabric-primitives/FabricEpochDay.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import { FabricHash } from "@/fabric-primitives/FabricHash.ts";
import { FabricKeyPair } from "@/fabric-primitives/FabricKeyPair.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";
import { FabricInstance } from "./interface.ts";
import { constructorOfObject } from "@commonfabric/utils/objects";

import { NATIVE_TAGS, type NativeTag } from "./native-tags.ts";
import {
  isNativeError,
  tagFromNativeBuiltinClass,
} from "./native-builtin-tags.ts";

export { NATIVE_TAGS, type NativeTag } from "./native-tags.ts";
export {
  isNativeError,
  isValidFabricNativeObject,
} from "./native-builtin-tags.ts";

/**
 * Maps a constructor to its native-instance tag. Returns the tag string if
 * the constructor is a recognized type (JS builtins or system-defined
 * `FabricPrimitive`s), or `null` otherwise.
 *
 * The builtins are asked first, by `tagFromNativeBuiltinClass()`. Order decides
 * nothing between the two -- a class is in one list or the other, never both --
 * so what it is chosen for is cost: a `switch` on object identity compares in
 * order, and plain objects and arrays outnumber everything else this is asked
 * about by a wide margin.
 */
export function tagFromNativeClass(
  constructorFn: { prototype: unknown },
): NativeTag | null {
  const builtin = tagFromNativeBuiltinClass(constructorFn);
  if (builtin !== null) return builtin;

  switch (constructorFn) {
    case FabricBytes:
      return NATIVE_TAGS.FabricBytes;
    case FabricEpochNsec:
      return NATIVE_TAGS.EpochNsec;
    case FabricEpochDay:
      return NATIVE_TAGS.EpochDay;
    case FabricHash:
      return NATIVE_TAGS.Hash;
    case FabricKeyPair:
      return NATIVE_TAGS.FabricKeyPair;
    case FabricRegExp:
      return NATIVE_TAGS.FabricRegExp;
    default:
      return null;
  }
}

/**
 * Maps a JS value to its native-instance tag. Returns the tag string if the
 * value is a recognized convertible native instance, or `null` otherwise.
 * Non-object types (`null`, `undefined`, primitives) return `Primitive`.
 *
 * An array is tagged `Array` before anything else is consulted.
 * `Array.isArray()` is realm-agnostic and sees through both a subclass and a
 * severed prototype, so every array reaches array handling and is decided by
 * the array rule, which alone decides what an array may be.
 */
export function tagFromNativeValue(value: unknown): NativeTag | null {
  if (value === null || typeof value !== "object") {
    return NATIVE_TAGS.Primitive;
  }

  // Arrays first, and unconditionally: see above.
  if (Array.isArray(value)) {
    return NATIVE_TAGS.Array;
  }

  const ctor = constructorOfObject(value);
  if (ctor !== undefined) {
    const tag = tagFromNativeClass(ctor);
    if (tag !== null) return tag;
  }

  // Reaching here means the value's class went unrecognized.

  // `Error`s with no reachable constructor -- e.g. one whose prototype has
  // been severed, or one from another realm. An ordinary subclass (including
  // `DOMException`) never gets here: the class lookup matches it via
  // `prototype instanceof Error`.
  if (isNativeError(value)) return NATIVE_TAGS.Error;

  // `FabricInstance` values (object-like protocol types).
  if (value instanceof FabricInstance) return NATIVE_TAGS.FabricInstance;

  // Null-prototype objects (`Object.create(null)`), which have no constructor
  // to have been recognized. Tagged `Object` so the object rule decides them
  // by name, the same way an indirect array is tagged `Array`.
  if (Object.getPrototypeOf(value as object) === null) {
    return NATIVE_TAGS.Object;
  }

  return null;
}
