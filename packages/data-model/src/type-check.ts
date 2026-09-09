/**
 * The _simple_ predicates deciding whether a value belongs to the `FabricValue`
 * type, and the narrowings that ask a shape question about one that already
 * does.
 */

import {
  isPlainContainer,
  isPlainObject,
} from "@commonfabric/utils/types";

import {
  type FabricArray,
  type FabricContainerValue,
  FabricInstance,
  type FabricPlainObject,
  type FabricValue,
} from "./interface.ts";

/**
 * Narrows to the container arms of `FabricValue` -- a plain object, an array,
 * or a `FabricInstance` -- that is, the values that hold other `FabricValue`s.
 *
 * Contrast `isFabricObjectOrArray()`, which is one arm wider: it also accepts a
 * `FabricPrimitive`, an object that is not a container. The two are not
 * interchangeable where the answer decides a descent.
 */
export function isFabricContainerValue(
  value: FabricValue,
): value is FabricContainerValue {
  return isPlainContainer(value) || value instanceof FabricInstance;
}

/**
 * Narrows to the two *plain* container arms of `FabricValue` -- an array or a
 * plain object -- the values whose contents are reachable by index or property
 * name. This is the question to ask before addressing into a value by key.
 *
 * Contrast `isFabricContainerValue()`, which is one arm wider: a
 * `FabricInstance` is a container, but it holds its contents privately, so a
 * key means nothing against one. Assigning through a value this rejects and
 * that one accepts puts an own property on an instance, which is a state no
 * `FabricInstance` has.
 */
export function isFabricPlainContainer(
  value: FabricValue,
): value is FabricArray | FabricPlainObject {
  return isPlainContainer(value);
}

/**
 * Indicates whether a `FabricValue` is a `FabricArray`. This is a type
 * predicate for `FabricArray`.
 */
export function isFabricArray(value: FabricValue): value is FabricArray {
  return Array.isArray(value);
}

/**
 * Indicates whether a `FabricValue` is a plain object, an array, or a
 * `FabricSpecialObject` -- everything a `typeof value === "object"` test
 * accepts, minus `null`. The name states the array case because "object" alone
 * reads as excluding it.
 *
 * The runtime behavior matches a bare `isObjectOrArray()` exactly. The
 * difference is static: `isObjectOrArray()` narrows to `Record<string,
 * unknown>`, which discards the fact that the value is a `FabricValue` -- so a
 * guarded value can no longer be handed to a `FabricValue` API. This keeps that
 * half.
 *
 * Contrast `isFabricPlainObject()`, which is strictly narrower at RUNTIME: it
 * accepts only plain objects, rejecting arrays and `FabricSpecialObject`s. The
 * two are not interchangeable. Between them sit
 * `isFabricContainerValue()`, which rejects only the `FabricPrimitive` half of
 * `FabricSpecialObject`, and `isFabricPlainContainer()`, which rejects all of
 * it.
 */
export function isFabricObjectOrArray(
  value: FabricValue,
): value is FabricValue & object {
  return typeof value === "object" && value !== null;
}

/**
 * Narrows to the plain-record arm of `FabricValue` (`FabricPlainObject`): an
 * object whose prototype is `Object.prototype` or `null`. This rejects arrays,
 * `FabricSpecialObject`s, and other class instances (`Date`, `Map`, …), none of
 * which are representable as a `FabricPlainObject`. Unlike a bare
 * `isObjectOrArray()` check, it preserves the value type —
 * `FabricPlainObject`'s string index of `FabricValue` keeps an indexed value
 * typed as a `FabricValue`.
 *
 * This asks a shape question -- "may I read this by property name?" -- of a
 * value the type already says is a `FabricValue`, and a null-prototype object
 * answers yes as readily as any other record. That makes it deliberately looser
 * than membership: a `FabricPlainObject` is `Object.prototype`-rooted, so
 * `isValidFabricValue()` refuses the null-prototype object this accepts. The
 * looseness costs nothing, the input being out of contract either way, and it
 * keeps callers holding un-validated values from losing a reader they can use.
 * For the membership question asked of an `unknown`, see
 * `isValidFabricPlainObject()`.
 */
export function isFabricPlainObject(
  value: FabricValue,
): value is FabricPlainObject {
  return isPlainObject(value);
}
