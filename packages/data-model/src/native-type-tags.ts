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
 * This module is the half of that dispatch which holds the fabric classes, and
 * so is layered above them. The half that needs none of them --  the tag
 * vocabulary, the native builtins, and the walk both halves share -- is in
 * `native-builtin-tags.ts`, and is what a module layered below the fabric
 * classes asks instead. The names that module defines are re-exported here, so
 * that a caller with no interest in the split sees one module.
 */

import { FabricEpochDay } from "@/fabric-primitives/FabricEpochDay.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import { FabricHash } from "@/fabric-primitives/FabricHash.ts";
import { FabricKeyPair } from "@/fabric-primitives/FabricKeyPair.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";
import { FabricInstance } from "./interface.ts";
import {
  NATIVE_TAGS,
  type NativeTag,
  tagFromNativeBuiltinClass,
  tagFromNativeValueUsing,
} from "./native-builtin-tags.ts";

export {
  isNativeError,
  isValidFabricNativeObject,
  NATIVE_TAGS,
  type NativeTag,
} from "./native-builtin-tags.ts";

/**
 * Maps a constructor to its native-instance tag. Returns the tag string if
 * the constructor is a recognized type (JS builtins or system-defined
 * `FabricPrimitive`s), or `null` otherwise.
 *
 * The fabric classes are asked first, and the JS builtins are then asked by
 * `tagFromNativeBuiltinClass()`. Order does not decide anything between them:
 * a class is in one list or the other, never both.
 */
export function tagFromNativeClass(
  constructorFn: { prototype: unknown },
): NativeTag | null {
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
      return tagFromNativeBuiltinClass(constructorFn);
  }
}

/**
 * Maps a JS value to its native-instance tag. Returns the tag string if the
 * value is a recognized convertible native instance, or `null` otherwise.
 * Non-object types (`null`, `undefined`, primitives) return `Primitive`.
 *
 * The walk to the value's class, and the array and native-error rules that
 * ride on it, are `tagFromNativeValueUsing()`'s; what this adds is the class
 * lookup that knows the fabric classes, plus the two fallbacks below for
 * values whose class was not recognized at all.
 */
export function tagFromNativeValue(value: unknown): NativeTag | null {
  const tag = tagFromNativeValueUsing(value, tagFromNativeClass);
  if (tag !== null) return tag;

  // Reaching here means the value is an object -- a non-object is tagged
  // `Primitive` above -- whose class went unrecognized.

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
