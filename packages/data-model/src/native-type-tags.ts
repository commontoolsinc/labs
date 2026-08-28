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
 */

import { constructorOfPrototype } from "@commonfabric/utils/objects";

import { VALUE_TAGS, type ValueTag } from "./VALUE_TAGS.ts";
import {
  isNativeError,
  tagFromNativeBuiltinClass,
} from "./native-builtin-tags.ts";
import { FabricEpochDay } from "@/fabric-primitives/FabricEpochDay.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import { FabricHash } from "@/fabric-primitives/FabricHash.ts";
import { FabricKeyPair } from "@/fabric-primitives/FabricKeyPair.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";
import { FabricInstance } from "./interface.ts";

/**
 * Maps a constructor to its tag. Returns the tag string if the constructor is a
 * recognized type (JS builtins or system-defined `FabricPrimitive`s), or `null`
 * otherwise.
 *
 * The builtins are asked first, by `tagFromNativeBuiltinClass()`. Order decides
 * nothing between the two -- a class is in one list or the other, never both --
 * so what it is chosen for is cost: a `switch` on object identity compares in
 * order, and plain objects and arrays outnumber everything else this is asked
 * about by a wide margin.
 */
export function tagFromNativeClass(
  constructorFn: { prototype: unknown },
): ValueTag | null {
  const builtin = tagFromNativeBuiltinClass(constructorFn);
  if (builtin !== null) return builtin;

  switch (constructorFn) {
    case FabricBytes:
      return VALUE_TAGS.FabricBytes;
    case FabricEpochNsec:
      return VALUE_TAGS.EpochNsec;
    case FabricEpochDay:
      return VALUE_TAGS.EpochDay;
    case FabricHash:
      return VALUE_TAGS.Hash;
    case FabricKeyPair:
      return VALUE_TAGS.FabricKeyPair;
    case FabricRegExp:
      return VALUE_TAGS.FabricRegExp;
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
  }

  const proto = Object.getPrototypeOf(value);

  // A `null` prototype settles the value here, both ways it can go. It names
  // no class, so nothing below could recognize one; and `instanceof` walks a
  // chain that is empty, so the `FabricInstance` test below cannot claim it
  // either. What is left is an `Error` whose prototype was severed -- still an
  // error, and `Error.isError()` is what sees it -- or a bare record, which is
  // tagged `Object` so the object rule decides it by name, the same way an
  // indirect array is decided by the array rule.
  if (proto === null) {
    return isNativeError(value) ? VALUE_TAGS.Error : VALUE_TAGS.Object;
  }

  // The class is read from the PROTOTYPE, not from the value. What is being
  // asked is which class the value is an instance of, and that is a fact about
  // its prototype; an own `constructor` property is ordinary data that happens
  // to share the name, and must not decide the value's type. Reading it off
  // the value would let `{constructor: Error}` -- a plain record -- be tagged
  // `Error` and silently rebuilt as one.
  const ctor = constructorOfPrototype(proto);

  if (ctor !== undefined) {
    const tag = tagFromNativeClass(ctor);
    if (tag !== null) return tag;
  }

  // Fallbacks for values whose constructor wasn't recognized.

  // `Error`s with no reachable constructor -- e.g. one from another realm. An
  // ordinary subclass (including `DOMException`) never gets here:
  // `tagFromNativeClass()` matches it via `prototype instanceof Error`.
  if (isNativeError(value)) return VALUE_TAGS.Error;

  // `FabricInstance` values (object-like protocol types).
  if (value instanceof FabricInstance) return VALUE_TAGS.FabricInstance;

  return null;
}
