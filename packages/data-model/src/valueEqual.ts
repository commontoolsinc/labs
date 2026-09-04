import { deepEqual } from "@commonfabric/utils/deep-equal";
import { backtickQuote } from "@commonfabric/utils/markdown";
import { isPlainObject } from "@commonfabric/utils/types";
import { isDeepFrozen } from "./deep-freeze.ts";
import {
  type FabricArray,
  type FabricPlainObject,
  FabricSpecialObject,
  type FabricValue,
} from "./interface.ts";
import { hashStringOf } from "./value-hash.ts";
import { toCompactDebugString } from "./value-debug.ts";

/**
 * Compares two `FabricValue`s for logical (content) equality.
 *
 * This is the `data-model`-aware equality the storage layer's no-op /
 * change-detection gates need, and the fix for what `deepEqual()` gets wrong:
 * any `FabricSpecialObject` (`FabricPrimitive` leaves like `FabricBytes` /
 * `FabricRegExp` / `FabricEpoch*` / `FabricHash`, and `FabricInstance`
 * wrappers) keeps its state in private `#fields` with zero enumerable
 * own-properties, so `deepEqual()` conflates every distinct same-class instance
 * as equal (the CT-1770 bug). Here object equality is decided by canonical
 * content hash (`hashStringOf()`), which feeds special objects, plain objects,
 * and arrays alike — including the distinctions a naive walk misses (sparse
 * array holes vs a stored `undefined`, a present `undefined` vs an absent key)
 * — so a special object nested arbitrarily deep is still compared by content.
 *
 * (Unlike `deepEqual()` it does not handle non-`Fabric` class instances or
 * non-index properties on arrays: those are not representable as
 * `FabricValue`s.)
 */
export function valueEqual(a: FabricValue, b: FabricValue): boolean {
  if (Object.is(a, b)) return true;

  switch (typeof a) {
    case "object": {
      // `null` is the one `object`-typed value that isn't a container; with
      // `Object.is()` already ruled out, `a === null` can't equal `b`.
      if (a === null) return false;
      break;
    }

    case "function": {
      // Not a `FabricValue`; reachable only via an unsound cast.
      throw new Error("Cannot compare a function value.");
    }

    default: {
      // Any other type is a primitive that `Object.is()` already settled as
      // unequal above.
      return false;
    }
  }

  // `a` is a non-`null` object. Classify `b` the same way, so invalid input
  // fails identically regardless of argument order: only another non-`null`
  // object can be equal to `a`.
  switch (typeof b) {
    case "object": {
      // A non-`null` object can't equal `null`; otherwise compare below.
      if (b === null) return false;
      break;
    }

    case "function": {
      // Not a `FabricValue`; reachable only via an unsound cast.
      throw new Error("Cannot compare a function value.");
    }

    default: {
      // `b` is a primitive, which can't equal the object `a`.
      return false;
    }
  }

  // The canonical content hash is the general object comparator, but it's worth
  // a few cheap checks first.

  if (isDeepFrozen(a) && isDeepFrozen(b)) {
    // Both sides are deep-frozen, the hash is cacheable (frozen ~==
    // non-ephemeral), so hashing can be reasonably assumed to pay for itself.
    return hashStringOf(a) === hashStringOf(b);
  }

  // Otherwise, short-circuit the mismatched subtypes that can never be equal,
  // without paying for a hash.

  const subtype = objectSubtypeOf(a);
  const bSubtype = objectSubtypeOf(b);

  if (subtype !== bSubtype) {
    // Different subtypes can't possibly be equal.
    return false;
  }

  switch (subtype) {
    case "array": {
      // Alas, casts are required because TS doesn't know the correspondence
      // between subtype names and type restrictions.
      const aArray = a as FabricArray;
      const bArray = b as FabricArray;
      if (aArray.length !== bArray.length) {
        // Arrays can't possibly be equal if lengths are different.
        return false;
      }
      break;
    }

    case "plain": {
      // Alas, casts are required because TS doesn't know the correspondence
      // between subtype names and type restrictions.
      const aObject = a as FabricPlainObject;
      const bObject = b as FabricPlainObject;
      if (Object.keys(aObject).length !== Object.keys(bObject).length) {
        // Plain objects can't possibly be equal if they have different numbers
        // of properties.
        return false;
      }
      break;
    }

    case "special": {
      if (a.constructor !== b.constructor) {
        // `FabricSpecialObject`s (instances in general, really) can't possibly
        // be equal if they are of different concrete classes.
        return false;
      }
      break;
    }
  }

  // No quick check managed to disqualify full-scale comparison. So it goes.
  return hashStringOf(a) === hashStringOf(b);
}

/**
 * Compares two values of unknown type for logical equality: the way
 * {@link valueEqual} does where the data model can decide them, and the way
 * `deepEqual()` does where it cannot, with every `FabricSpecialObject` reached
 * along that second path still decided by content.
 *
 * This is the comparison for an operand that is *allowed* to hold a
 * `FabricValue` without being known to be one: a schema `const` against a
 * stored value, a schema default against a materialized one, a write against
 * the value it replaces, a request against the snapshot a policy was checked
 * over. Neither half serves alone. `valueEqual()` is defined over
 * `FabricValue`s and throws on any other class instance, which these operands
 * still carry -- a `Cell`, a query-result proxy. `deepEqual()` compares by
 * enumerable own-properties, and a special object has none, so on its own it
 * reads two distinct same-class ones as equal and a gate built on it passes
 * values it exists to distinguish.
 *
 * Asking the model first is what decides a value it admits by content rather
 * than by property walk, and it is also the cheaper order, `valueEqual()`
 * comparing deep-frozen operands by a content hash cached on identity.
 *
 * The order is visible in one case, and it is a case neither half speaks for.
 * `valueEqual()` calls a null-prototype object equal to a plain object holding
 * the same contents, where `deepEqual()` separates them on their constructors;
 * `isValidFabricValue()` meanwhile does not admit a null-prototype object at
 * all, so this is two functions answering about a value outside the type
 * rather than the model settling it. The order here follows what the sites
 * that need this comparison already did, not that case.
 *
 * Cross-kind pairs on the structural path answer `false` rather than throwing:
 * a special object is equal only to another special object, so pairing one
 * with a plain record, an array, or any other instance settles the comparison
 * without asking the data model about a value that is not its business. A pair
 * whose class cannot yet be hashed still throws, from either path; see
 * `valueEqual()`.
 *
 * The `catch` takes everything, and a narrower one does not work. What it is
 * for is `valueEqual()` declining operands outside the type, so the obvious
 * refinement is to ask `isValidFabricValue()` on the way out and re-raise
 * where both operands are values the model does admit -- a `FabricMap` or a
 * `FabricSet`, whose codecs are stubs. Measured, that breaks three tests, and
 * the reason generalizes: what `valueEqual()` can compare is not what the type
 * admits. `isValidFabricValue()` carries a `seen` set and answers for a cyclic
 * value; `hashStringOf()` has none and exhausts the stack on one. So a
 * `RangeError` from a legal cyclic record reaches the same `catch` as a
 * refusal, and it is not the model reporting on its own values.
 *
 * The fallback answering where the hash cannot is the feature rather than the
 * hazard, which the tempting counter-example gets backwards: comparing
 * `{ v: aFabricMap }` against `{ v: 5 }` returns `false` here, not because a
 * failure was swallowed but because a `FabricMap` is not equal to `5` and the
 * walk can see that without hashing anything. Where a comparison does turn on
 * a stub class, the two operands meet at `specialObjectEqual()`, which hands
 * them back to `valueEqual()` and lets the refusal out.
 *
 * This is the compare-side half of admitting special objects; the walk-side
 * half is `isWalkableObjectOrArray()`.
 */
export function fabricAwareEqual(a: unknown, b: unknown): boolean {
  try {
    return valueEqual(a as FabricValue, b as FabricValue);
  } catch {
    return deepEqual(a, b, specialObjectEqual);
  }
}

/**
 * Helper for {@link fabricAwareEqual}, deciding the object pairs in which
 * either side is a `FabricSpecialObject` and declining the rest.
 */
function specialObjectEqual(a: object, b: object): boolean | undefined {
  const aIsSpecial = a instanceof FabricSpecialObject;
  const bIsSpecial = b instanceof FabricSpecialObject;

  if (!(aIsSpecial || bIsSpecial)) return undefined;
  if (!(aIsSpecial && bIsSpecial)) return false;

  return valueEqual(a, b);
}

/**
 * Helper for {@link #valueEqual}, which classifies object subtypes. This
 * `throw`s given an object that shouldn't have been passed as a `FabricValue`.
 */
function objectSubtypeOf(
  value: FabricPlainObject | FabricArray | FabricSpecialObject,
): "array" | "plain" | "special" {
  if (value instanceof FabricSpecialObject) {
    return "special";
  } else if (Array.isArray(value)) {
    return "array";
  } else if (isPlainObject(value)) {
    return "plain";
  } else {
    throw new Error(
      `Cannot compare value ${backtickQuote(toCompactDebugString(value))}`,
    );
  }
}
