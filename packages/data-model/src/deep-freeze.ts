import type { FabricValue } from "./interface.ts";
import {
  BaseFabricInstance,
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
} from "./fabric-instances/BaseFabricInstance.ts";
import { BaseFabricPrimitive } from "./fabric-primitives/BaseFabricPrimitive.ts";
import { isFabricValue } from "./type-check.ts";

/**
 * Cache of confirmed deep-frozen objects.
 */
const deepFrozenCache = new WeakSet<object>();

/**
 * Object graphs already proven to be both deeply frozen and valid `FabricValue`s,
 * memoized by root identity for `isDeepFrozenFabricValue()`.
 *
 * Caching by identity is sound because of the "Deep-frozen honesty" mandate (see
 * the `[IS_DEEP_FROZEN]` protocol member on `BaseFabricInstance` and the
 * `FabricValue` doc in `interface.ts`): a `FabricValue` may not expose an accessor
 * whose result contradicts its frozen state, and a `FabricInstance` may not report
 * deep-frozen unless permanently immutable. So a proven deep-frozen fabric value
 * stays one -- including graphs reaching a `FabricInstance` -- and its proof does
 * not need re-validation. A class that violates the mandate can corrupt this cache,
 * as any contract violation can; that is the implementing class's bug, not this
 * code's to defend against.
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
 * Indicates whether the value is a deep-frozen `FabricValue`: it is both a
 * `FabricValue` by structural membership (`isFabricValue()`) and deeply frozen
 * (`isDeepFrozen()`). Equivalent to `isFabricValue(value) && isDeepFrozen(value)`,
 * with an identity-cached fast path for values already proven.
 *
 * The cache is sound because a `FabricValue` must report its frozen state
 * truthfully and permanently -- see the "Deep-frozen honesty" mandate on the
 * `[IS_DEEP_FROZEN]` protocol member (`BaseFabricInstance`) and on `FabricValue`
 * (`interface.ts`): no member exposes an accessor whose result contradicts its
 * frozen state, and no `FabricInstance` reports deep-frozen unless permanently
 * immutable. A proven deep-frozen fabric value therefore stays one, so its proof
 * is cached by root identity and not re-validated.
 *
 * (Membership is gated by `isFabricValue()`: `isDeepFrozen()` alone admits
 * `function`s via the `isNecessarilyFrozenValue()` bug, but `isFabricValue()`
 * rejects them, so the conjunction is correct for all in-spec values.)
 */
export function isDeepFrozenFabricValue(value: unknown): value is FabricValue {
  if (
    typeof value === "object" && value !== null &&
    deepFrozenFabricValueCache.has(value)
  ) {
    return true;
  }

  const result = isFabricValue(value) && isDeepFrozen(value);

  if (result && typeof value === "object" && value !== null) {
    deepFrozenFabricValueCache.add(value);
  }

  return result;
}
