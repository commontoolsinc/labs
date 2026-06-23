import { isDeepFrozen } from "./deep-freeze.ts";
import { FabricSpecialObject, type FabricValue } from "./interface.ts";
import { hashStringOf } from "./value-hash.ts";

/**
 * Is the value a plain record — an object whose prototype is `Object.prototype`
 * or `null`? This rejects arrays, class instances, and built-ins like `Map` /
 * `Date`, none of which are representable as a `FabricValue` record.
 */
function isPlainRecord(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype) || (proto === null);
}

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
 * named properties on arrays: those are not representable as `FabricValue`s.)
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

  // When both sides are deep-frozen, the hash is cacheable (frozen ≈
  // non-ephemeral), so hashing pays for itself even on a repeat — take it early.
  if (isDeepFrozen(a) && isDeepFrozen(b)) {
    return hashStringOf(a) === hashStringOf(b);
  }

  // Otherwise, short-circuit the mismatched subtypes that can never be equal,
  // without paying for a hash.
  const aIsSpecial = a instanceof FabricSpecialObject;
  const bIsSpecial = b instanceof FabricSpecialObject;
  if (aIsSpecial || bIsSpecial) {
    // A special object and a plain object can never share a hash (distinct type
    // tags), so a subtype mismatch is unequal outright.
    if (aIsSpecial !== bIsSpecial) return false;
    // Both special: two different concrete classes have distinct type tags and
    // can never hash-equal, so short-circuit without hashing. Same-class
    // instances fall through to the hash compare below.
    if (a.constructor !== b.constructor) return false;
  } else {
    // Both are non-`null`, non-special objects. An array and a non-array can't
    // be equal, nor can two arrays of differing length or two records of
    // differing key count.
    const aIsArray = Array.isArray(a);
    const bIsArray = Array.isArray(b);
    if (aIsArray !== bIsArray) return false;
    if (aIsArray && bIsArray) {
      if (a.length !== b.length) return false;
    } else {
      // A non-array object here must be a plain record to be a `FabricValue`. A
      // stray class instance (`Map`, `Date`, a user class, …) is reachable only
      // via an unsound cast; reject it explicitly rather than treating it as an
      // empty record.
      if (!isPlainRecord(a) || !isPlainRecord(b)) {
        throw new Error("Cannot compare a non-record object value.");
      }
      if (Object.keys(a).length !== Object.keys(b).length) return false;
    }
  }

  return hashStringOf(a) === hashStringOf(b);
}
