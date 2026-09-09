/**
 * Answering what a JS value already is, so that conversion can decide what to
 * make of it. These tags name the value's own class, and are unrelated to the
 * tags a wire format writes, which say what it became.
 *
 * The question is harder than an `instanceof` because the answer must not be
 * forgeable. A class is read off the prototype rather than off the value,
 * since an own `constructor` property is ordinary data that would otherwise
 * let a plain record present itself as an `Error`.
 *
 * Two kinds of value are recognized with no reachable class at all, which is
 * why the constructor switch has fallbacks beneath it rather than standing
 * alone: an array, by `Array.isArray()`, and an error, by `Error.isError()`.
 * Each tests an internal slot rather than a prototype, so each holds across
 * realms and through a severed prototype.
 *
 * Nothing else does. A `Date`, `Map`, `Set`, `RegExp` or `Uint8Array` is
 * recognized by constructor identity, which is a per-realm question, and one
 * of those from another realm is reported as unrecognized. Values from another
 * realm are outside what this is asked about.
 */

import { constructorOfPrototype } from "@commonfabric/utils/objects";

import { VALUE_TAGS, type ValueTag } from "./VALUE_TAGS.ts";
import { tagFromNativeBuiltinClass, tagFromFabricPrimitiveElseNull } from "./tag-from.ts";
import { FabricInstance, FabricPrimitive } from "./interface.ts";

/**
 * Maps a JS value to its native-instance tag. Returns the tag string if the
 * value is a recognized convertible native instance, or `null` otherwise.
 * Non-object types (`null`, `undefined`, primitives) return `Primitive`.
 *
 * An array is tagged `Array` before anything else is consulted.
 * `Array.isArray()` is realm-agnostic and sees through both a subclass and a
 * severed prototype, so every array reaches array handling and is decided by
 * the array rule, which alone decides what an array may be.
 *
 * Otherwise dispatches via the value's constructor (O(1) switch in
 * `tagFromNativeClass`, which matches `Error` subclasses via `prototype
 * instanceof Error`), falling back to native error detection for values whose
 * constructor is unreachable -- a severed prototype, or another realm -- and to
 * a prototype check for null-prototype objects.
 */
export function tagFromNativeValue(value: unknown): ValueTag | null {
  if (value === null || typeof value !== "object") {
    return VALUE_TAGS.Primitive;
  }

  // Arrays first, and unconditionally: see above.
  if (Array.isArray(value)) {
    return VALUE_TAGS.Array;
  } else if (Error.isError(value)) {
    return VALUE_TAGS.Error;
  } else if (value instanceof FabricPrimitive) {
    return tagFromFabricPrimitiveElseNull(value);
  } else if (value instanceof FabricInstance) {
    return VALUE_TAGS.FabricInstance;
  }

  const proto = Object.getPrototypeOf(value);

  // We treat a `null` prototype as type `Object`, because due to the checks
  // above, it can't be a cross-realm type of any sort we attempt to recognize.
  if (proto === null) {
    return VALUE_TAGS.Object;
  }

  // The class is read from the PROTOTYPE, not from the value. What is being
  // asked is which class the value is an instance of, and that is a fact about
  // its prototype; an own `constructor` property is ordinary data that happens
  // to share the name, and must not decide the value's type. Reading it off
  // the value would let `{constructor: Error}` -- a plain record -- be tagged
  // `Error` and silently rebuilt as one.
  const ctor = constructorOfPrototype(proto);

  return (ctor === undefined)
    ? null
    : tagFromNativeBuiltinClass(ctor);
}
