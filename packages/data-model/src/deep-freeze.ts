import { isPlainObject } from "@commonfabric/utils/types";
import { isArrayWithOnlyIndexProperties } from "@commonfabric/utils/arrays";

import type { FabricValue } from "./interface.ts";
import {
  BaseFabricInstance,
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
} from "./fabric-instances/BaseFabricInstance.ts";
import { BaseFabricPrimitive } from "./fabric-primitives/BaseFabricPrimitive.ts";

/**
 * Cache of confirmed deep-frozen objects.
 */
const deepFrozenCache = new WeakSet<object>();

/**
 * Data-descriptor-only object graphs already proven to be both deeply frozen
 * and valid Fabric values. Accessors and FabricInstance protocol values are
 * deliberately excluded: Object.freeze() does not freeze their closed-over or
 * private logical state, so their proof is not stable by root identity.
 *
 * TODO(danfuzz): Evaluate the above reasoning as to why `FabricInstance` is
 * excluded. Though it's certainly true that `#private` members mean that
 * something which is deep-frozen per the JavaScript contract might not _really_
 * be deep frozen, the data model's contract for the `IS_DEEP_FROZEN` protocol
 * should make it so that clients can in fact rely on `FabricInstance`s' reports
 * about their deep-frozenness. To the extent that a `FabricInstance` class is
 * "lying" about its effective frozenness, it probably shouldn't be up to _this_
 * code to paper over that fact.
 */
const deepFrozenFabricValueCache = new WeakSet<object>();

/**
 * Adds a value which has been determined to be deep-frozen to the cache.
 */
function addToDeepFrozenCache(obj: object) {
  deepFrozenCache.add(obj);
}

/**
 * Indicates whether or not the given object is already in the
 * `deepFrozenCache`.
 */
function isInDeepFrozenCache(obj: object): boolean {
  return deepFrozenCache.has(obj);
}

/**
 * Indicates whether or not a value is "necessarily frozen." As of this writing,
 * this is _intended_ to be the same as asking if it's a primitive value, but
 * with an emphasis on the point. However, at some point we'll end up with
 * special knowledge about objects which are also "necessarily frozen" by
 * construction, and this is the place where we'll get to expand the logic
 * accordingly.
 *
 * TODO(danfuzz): This produces an incorrect result for values of type
 * `function`, which are neither primitives nor necessarily frozen: a function
 * is an ordinary mutable object, but `typeof fn !== "object"` lets it pass here
 * as "necessarily frozen." Two consequences, both live: `isDeepFrozen()`
 * reports `true` for any graph that reaches a function, and `deepFreeze()`
 * silently declines to freeze one -- so a graph both of them call deep-frozen
 * can still be mutated through it.
 *
 * The deeper trouble is that this file isn't consistent about which of its
 * functions answer a question about arbitrary JavaScript values and which
 * answer one about `FabricValue`s. For a function the two answers legitimately
 * differ -- it's a mutable JS object, and it isn't a `FabricValue` at all --
 * and only the `FabricValue`-shaped one (`isDeepFrozenFabricValue()`) is
 * currently right. Sorting out that distinction is the actual fix; patching
 * `typeof` tests one at a time is not.
 */
function isNecessarilyFrozenValue(value: unknown): boolean {
  return (value === null) || (typeof value !== "object");
}

/**
 * Indicates whether the given value is either _necessarily_ or _already known
 * to be_ deep-frozen.
 */
function isNecessarilyOrKnownDeepFrozen(value: unknown): boolean {
  // Note: The `as` cast here is safe because the antecedent being `false` means
  // that `value` must be an `object` consequent.
  return isNecessarilyFrozenValue(value) ||
    isInDeepFrozenCache(value as object);
}

/**
 * Returns `true` if the value is deeply frozen: either a primitive, or a
 * frozen object/array whose every nested value is also deeply frozen
 * (recursively). Caches results for fast repeat checks.
 *
 * Handles circular references and sparse arrays.
 */
export function isDeepFrozen(value: unknown): boolean {
  // Fast leaf paths first, so a primitive or already-cached value answers
  // without allocating the cycle-tracking set or the recursion closure below.
  if (isNecessarilyOrKnownDeepFrozen(value)) {
    return true;
  } else if (!Object.isFrozen(value)) {
    return false;
  }

  // We have non-leaf structure to walk. Allocate the cycle-tracking set and
  // build the recursion callback ONCE here, reusing the same closure at every
  // layer rather than allocating an equivalent `(v) => …` per descent.
  const inProgress = new Set<object>();
  const check = (value: unknown): boolean => {
    if (isNecessarilyOrKnownDeepFrozen(value)) {
      return true;
    } else if (!Object.isFrozen(value)) {
      return false;
    }

    const obj = value as object;

    // If we're already checking `obj` higher in the recursion, treat it as
    // frozen for the rest of this check: it only ends up marked actually
    // deep-frozen if the outer check confirms.
    if (inProgress.has(obj)) return true;
    inProgress.add(obj);

    let result = true;

    if (BaseFabricInstance.isInstance(obj)) {
      // A fabric instance's logical contents are not its enumerable own-props
      // (e.g. a `FabricError` keeps its custom properties in a private extras
      // `Map`), so it answers the deep-frozen question via its
      // `[IS_DEEP_FROZEN]` protocol member -- the side-effect-free sibling of
      // `[DEEP_FREEZE]` -- recursing into each nested `FabricValue` through
      // `check`, which shares this call's cycle state. Gating via
      // `BaseFabricInstance.isInstance()` keeps this generic (and enforces the
      // "every `FabricInstance` is a `BaseFabricInstance`" invariant); the
      // member is abstract on `BaseFabricInstance`, so every instance implements
      // it. (A `FabricPrimitive` is necessarily frozen with no outbound
      // references, so the `Object.values` arm below answers it correctly by
      // accident -- its empty enumerable props yield `true`.)
      result = obj[IS_DEEP_FROZEN](check);
    } else if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        if (!(i in obj)) continue; // sparse hole
        if (!check(obj[i])) {
          result = false;
          break;
        }
      }
    } else {
      for (const v of Object.values(obj)) {
        if (!check(v)) {
          result = false;
          break;
        }
      }
    }

    inProgress.delete(obj);
    if (result) {
      addToDeepFrozenCache(obj);
    }
    return result;
  };

  return check(value);
}

/**
 * Recursively freezes the given value in place. Dispatches on four arms, in
 * order:
 *
 * 1. Necessarily- or already-known-deep-frozen value (primitives and cached
 *    objects): short-circuit unchanged.
 * 2. `FabricPrimitive` instance: short-circuit unchanged -- these self-freeze
 *    at construction and have no outbound references.
 * 3. Fabric instance: delegate generically to its `[DEEP_FREEZE]` protocol
 *    member, handing recursion through as the `subFreeze` callback. The
 *    dispatch gates via `BaseFabricInstance.isInstance()` (where the member is
 *    declared) -- it operates generically and does not enumerate concrete
 *    subclasses.
 * 4. Plain object or array: recursively freeze children, then freeze the
 *    container.
 *
 * Arrays and plain objects are frozen after their children are recursively
 * frozen. Primitives pass through unchanged. Records the result in the
 * deep-frozen cache so subsequent `isDeepFrozen()` checks return in O(1).
 * Returns the (now-frozen) value.
 *
 * Handles circular references: a shared `inProgress` set is threaded through
 * all recursive calls -- including into participating `FabricInstance`s'
 * `[DEEP_FREEZE]` impls via the `subFreeze` callback closure -- so a cycle
 * back to a value currently being deep-frozen short-circuits rather than
 * recursing infinitely.
 */
export function deepFreeze<T>(value: T): T {
  // Arm 1: necessarily- or already-known-deep-frozen.
  if (isNecessarilyOrKnownDeepFrozen(value)) {
    return value;
  }

  // Arm 2: `FabricPrimitive`s are by definition frozen (they self-freeze at
  // construction) and have no outbound references. Handling arms 1 and 2 here,
  // before allocating the cycle-tracking set or the recursion closure below,
  // keeps primitives and `FabricPrimitive`s off the heavyweight path.
  if (BaseFabricPrimitive.isInstance(value)) {
    return value;
  }

  // We have non-leaf structure to freeze. Allocate the shared cycle-detection
  // set and build the recursion callback ONCE here, reusing the same closure
  // at every layer -- including as the `subFreeze` passed into participating
  // `FabricInstance`s' `[DEEP_FREEZE]` impls -- rather than allocating an
  // equivalent `(v) => …` per descent.
  //
  // The closure does NOT remove values from `inProgress` (unlike the
  // deep-frozen *check*, whose answer is local to each subtree): a value being
  // deep-frozen stays-the-course, so the outer call owns the freeze and every
  // cycle-arrival defers to it.
  const inProgress = new Set<object>();
  const freeze = <U>(value: U): U => {
    // Leaf short-circuits, repeated for nested values reached by recursion.
    if (isNecessarilyOrKnownDeepFrozen(value)) {
      return value;
    }
    if (BaseFabricPrimitive.isInstance(value)) {
      return value;
    }

    const obj = value as object;

    if (inProgress.has(obj)) {
      // A cycle back to a value the outer call is already deep-freezing.
      // Short-circuit: the outer call owns the freeze; recursing here would
      // either loop or pre-freeze before the outer call finishes its own
      // children.
      return value;
    }
    inProgress.add(obj);

    // Arm 3: a fabric instance freezes itself in place via its `[DEEP_FREEZE]`
    // protocol member. `freeze` is handed in as the `subFreeze` callback: it
    // closes over `inProgress`, so the impl's recursion into nested
    // `FabricValue`s shares cycle state with this call -- the participating
    // instance doesn't need to be `inProgress`-aware in its own signature.
    if (BaseFabricInstance.isInstance(value)) {
      const result = value[DEEP_FREEZE](freeze) as U;
      // Cache the now-deep-frozen result so subsequent `isDeepFrozen()` checks
      // short-circuit in O(1), mirroring arm 4's cache-write below.
      addToDeepFrozenCache(result as object);
      return result;
    }

    // Arm 4: plain object or array -- recurse into children, then freeze.
    const alreadyFrozen = Object.isFrozen(value);

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (i in value) freeze(value[i]);
      }
    } else {
      const o = value as Record<string, unknown>;
      for (const key of Object.keys(o)) {
        freeze(o[key]);
      }
    }

    if (!alreadyFrozen) Object.freeze(value);
    addToDeepFrozenCache(value as object);
    return value;
  };

  return freeze(value);
}

/**
 * Indicates whether the value is a deep-frozen `FabricValue`. Returns `true` if
 * the value is a primitive, or a frozen object/array whose children are all
 * also deep-frozen `FabricValue`s.
 *
 * A value of type `function` is not a `FabricValue`, and so yields `false`,
 * whether it is the value itself or reached anywhere within it. Note that this
 * differs from `isDeepFrozen()`, which asks the JavaScript-level question and
 * (incorrectly) admits functions; see the `TODO` on
 * `isNecessarilyFrozenValue()`.
 */
export function isDeepFrozenFabricValue(value: unknown): value is FabricValue {
  // The recursive membership half of this check is available standalone as
  // `isFabricValue()` (in `type-check.ts`). This function deliberately keeps its
  // own combined walk rather than composing `isFabricValue(v) && isDeepFrozen(v)`:
  // the two are not equivalent. `isDeepFrozen()` identity-caches accessor-backed
  // graphs unconditionally, so that composition would report a stale `true` for
  // a graph whose accessor later yields an unfrozen (but structurally valid)
  // child, whereas this walk re-validates deep-frozenness per node and refuses
  // to identity-cache accessor-backed graphs. Frozen-ness therefore stays woven
  // into the membership recursion below.
  switch (typeof value) {
    case "function": {
      return false;
    }

    case "object": {
      if (value === null || deepFrozenFabricValueCache.has(value)) {
        return true;
      } else if (!isDeepFrozen(value)) {
        return false;
      }

      // Continue below the `switch`.
      break;
    }

    default: {
      // It's a primitive. Return here for efficiency, rather than do the
      // heavyweight setup for recursive tracing.
      return true;
    }
  }

  // At this point, it's known to be a deep-frozen value with internal
  // structure, but we don't know if it's actually a `FabricValue`.

  const seen = new Set<object>();
  let cacheableByIdentity = true;
  const checkValue = (item: unknown): boolean => {
    if (typeof item === "function") return false;
    if (item === null || typeof item !== "object") {
      // It's a non-function primitive.
      return true;
    } else if (seen.has(item)) {
      return true;
    } else if (!isDeepFrozen(item)) {
      // Accessors may expose a different child after the root was cached by
      // isDeepFrozen(). Recheck each currently observed object independently.
      return false;
    }

    seen.add(item);

    if (BaseFabricPrimitive.isInstance(item)) {
      // `FabricPrimitive`s are by definition frozen and have no outbound
      // references.
      return true;
    } else if (BaseFabricInstance.isInstance(item)) {
      // Object.freeze() cannot prove that a fabric instance's private logical
      // contents will remain unchanged, so validate it but do not root-cache a
      // graph that reaches one.
      cacheableByIdentity = false;
      // Fabric instances answer the deep-frozen question via their
      // `[IS_DEEP_FROZEN]` protocol member (the side-effect-free sibling of
      // `[DEEP_FREEZE]`), recursing through `checkValue`. Gating via
      // `BaseFabricInstance.isInstance()` keeps this guard generic (and enforces
      // the "every `FabricInstance` is a `BaseFabricInstance`" invariant); the
      // `[IS_DEEP_FROZEN]` member is abstract on `BaseFabricInstance`, so every
      // instance is guaranteed to implement it.
      return item[IS_DEEP_FROZEN](checkValue);
    } else if (Array.isArray(item)) {
      // Arrays with enumerable named properties have no fabric representation.
      if (!isArrayWithOnlyIndexProperties(item)) return false;
      for (let i = 0; i < item.length; i++) {
        if (!(i in item)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(item, i.toString());
        if (
          descriptor === undefined || descriptor.get !== undefined ||
          descriptor.set !== undefined
        ) {
          cacheableByIdentity = false;
        }
        if (!checkValue(item[i])) return false;
      }
      return true;
    } else if (isPlainObject(item)) {
      const record = item as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (
          descriptor === undefined || descriptor.get !== undefined ||
          descriptor.set !== undefined
        ) {
          cacheableByIdentity = false;
        }
        if (!checkValue(record[key])) return false;
      }
      return true;
    } else {
      // It's an instance of a class that isn't covered by the `FabricValue`
      // type definition.
      return false;
    }
  };

  const result = checkValue(value);
  if (result && cacheableByIdentity) deepFrozenFabricValueCache.add(value);
  return result;
}
