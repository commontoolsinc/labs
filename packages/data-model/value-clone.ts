import { FabricInstance, FabricValue } from "./interface.ts";
import { NATIVE_TAGS, tagFromNativeValue } from "./native-type-tags.ts";
import { isDeepFrozenFabricValue } from "./deep-freeze.ts";
import { type Immutable, isPlainContainer } from "@commonfabric/utils/types";
import { toDebugKindString } from "./value-debug.ts";

/**
 * Options for `cloneIfNecessary()`.
 */
export interface CloneOptions {
  /** Whether the result should be frozen. Default: `true`. */
  frozen?: boolean;
  /** Whether to clone deeply or shallowly. Default: `true`. */
  deep?: boolean;
  /**
   * Force a copy to be made.
   *
   * - When `frozen = false`: defaults to `true` (always clone to guarantee
   *   mutable isolation).
   * - When `frozen = true`: defaults to `false` (clone only if necessary
   *   to achieve frozenness).
   * - `{ frozen: true, force: true }` is an error (pointless to force-copy
   *   something that will be immutable anyway).
   * - `{ frozen: false, force: false, deep: false }`: valid -- caller owns
   *   the reference and wants it mutable; thaws if frozen, returns as-is
   *   if already mutable.
   * - `{ frozen: false, force: false, deep: true }`: error -- ambiguous
   *   semantics for trees with mixed frozenness.
   */
  force?: boolean;
}

/**
 * Tracks an object for circular reference detection during deep cloning.
 * Lazily allocates the `seen` set on first use, throws if a cycle is
 * detected, and adds the object to the set. Returns the (possibly
 * newly-allocated) set.
 */
function trackForCircularity(
  obj: object,
  seen: Set<object> | null,
): Set<object> {
  seen ??= new Set();
  if (seen.has(obj)) {
    throw new Error("Cannot deep-clone circular reference");
  }
  seen.add(obj);
  return seen;
}

/**
 * Clones an already-valid `FabricValue` to achieve a desired frozenness,
 * with control over depth and copy semantics.
 *
 * Unlike `fabricFromNativeValue()` (which converts native JS values into
 * fabric wrappers), this function assumes the input is already a valid
 * `FabricValue` and only adjusts frozenness by cloning where necessary.
 *
 * @param value - An already-valid `FabricValue`.
 * @param options - See `CloneOptions`. Defaults: `{ frozen: true, deep: true }`.
 */
export function cloneIfNecessary<T extends FabricValue>(
  value: T,
  options?: CloneOptions & { frozen?: true },
): Immutable<T>;
export function cloneIfNecessary<T extends FabricValue>(
  value: T,
  options: CloneOptions & { frozen: false },
): T;
export function cloneIfNecessary<T extends FabricValue>(
  value: T,
  options?: CloneOptions,
): T;
export function cloneIfNecessary<T extends FabricValue>(
  value: T,
  options?: CloneOptions,
): T {
  const frozen = options?.frozen ?? true;
  const deep = options?.deep ?? true;
  const force = options?.force ?? (frozen ? false : true);

  if (frozen && force) {
    throw new Error(
      "cloneIfNecessary: { frozen: true, force: true } is invalid " +
        "(pointless to force-copy an immutable value)",
    );
  }

  if (!frozen && !force && deep) {
    throw new Error(
      "cloneIfNecessary: { frozen: false, force: false, deep: true } is invalid " +
        "(ambiguous: mixed-frozenness trees have no clear shallow-thaw semantics)",
    );
  }

  return cloneHelper(value, frozen, deep, force) as T;
}

/**
 * Performs the unified clone for both shallow and deep modes.
 *
 * When `deep` is true, recursively clones containers and detects circular
 * references via `seen`. When `deep` is false, copies only the top-level
 * container (children are shared by reference).
 *
 * When `force` is false, returns the value as-is if its frozenness already
 * matches the requested state. When `force` is true, always copies (unless
 * the value is a primitive or special primitive).
 *
 * Deep mode uses `isDeepFrozenFabricValue()` for identity optimization;
 * shallow mode uses `Object.isFrozen(value) === frozen`.
 */
export function cloneHelper(
  value: FabricValue,
  frozen: boolean,
  deep: boolean,
  force: boolean,
  seen: Set<object> | null = null,
): FabricValue {
  // Identity optimization: when `force` is off, check if the value's frozenness
  // already matches the requested state. Deep mode uses
  // `isDeepFrozenFabricValue()`; shallow mode uses `Object.isFrozen(v) ===
  // frozen`.
  function canReturnAsIs(v: FabricValue): boolean {
    if (force) return false;
    if (deep) {
      if (frozen && isDeepFrozenFabricValue(v)) return true;
      if (!frozen && !Object.isFrozen(v)) return true;
      return false;
    }
    return Object.isFrozen(v) === frozen;
  }

  switch (tagFromNativeValue(value)) {
    // Inherently immutable types -- frozenness is irrelevant, no cloning
    // needed regardless of force.
    case NATIVE_TAGS.Primitive:
    case NATIVE_TAGS.EpochNsec:
    case NATIVE_TAGS.EpochDays:
    case NATIVE_TAGS.ContentHash:
    case NATIVE_TAGS.FabricBytes:
      return value;

    case NATIVE_TAGS.FabricInstance: {
      // Identity optimization: already-correct frozenness needs no clone.
      if (canReturnAsIs(value)) {
        return value;
      } else if (deep) {
        return (value as FabricInstance).deepClone(frozen);
      } else {
        return (value as FabricInstance).shallowClone(frozen);
      }
    }

    case NATIVE_TAGS.Array: {
      if (canReturnAsIs(value)) return value;
      const arr = value as FabricValue[];
      if (deep) seen = trackForCircularity(arr, seen);
      const copy: FabricValue[] = new Array(arr.length);
      for (let i = 0; i < arr.length; i++) {
        if (i in arr) {
          copy[i] = deep
            ? cloneHelper(arr[i], frozen, deep, force, seen)
            : arr[i];
        }
      }
      if (deep) seen!.delete(arr);
      if (frozen) Object.freeze(copy);
      return copy;
    }

    case NATIVE_TAGS.Object: {
      if (canReturnAsIs(value)) return value;
      const obj = value as object;
      if (deep) seen = trackForCircularity(obj, seen);
      // Preserve null prototypes (e.g. `Object.create(null)`).
      const proto = Object.getPrototypeOf(obj);
      const copy = Object.create(proto) as Record<string, FabricValue>;
      if (deep) {
        for (const [key, val] of Object.entries(obj)) {
          copy[key] = cloneHelper(
            val as FabricValue,
            frozen,
            deep,
            force,
            seen,
          );
        }
        seen!.delete(obj);
      } else {
        Object.assign(copy, value as Record<string, unknown>);
      }
      if (frozen) Object.freeze(copy);
      return copy;
    }

    default:
      // All valid `FabricValue` types are handled above.
      throw new Error(
        `Cannot clone: ${(value as object).constructor?.name ?? typeof value}`,
      );
  }
}

// =============================================================================
// `cloneForMutation`
// =============================================================================

/**
 * Options for `cloneForMutation()`.
 */
export interface CloneForMutationOptions {
  /**
   * Force fresh shallow copies of every spine container, even when the
   * input's containers are already mutable. Default: `true` -- matches
   * `cloneIfNecessary`'s default when `frozen: false` (which is what each
   * per-container thaw effectively requests).
   *
   * - `force: true` (default) — the caller's input is guaranteed to be left
   *   untouched. Every container along the spine -- including the root and
   *   the value at `path` -- is a fresh shallow copy.
   * - `force: false` — spine containers that are already mutable are reused
   *   by identity, and the helper may mutate the caller's input's spine
   *   slots in place when it needs to splice a freshly-thawed child into a
   *   mutable parent. Choose this when the caller owns the input outright.
   *
   * Mirrors `cloneIfNecessary`'s `force` semantics: this option is forwarded
   * verbatim to the per-container `cloneIfNecessary(_, { frozen: false,
   * deep: false, force })` calls that perform the actual shallow thaws.
   */
  force?: boolean;
}

/**
 * The shape returned by `cloneForMutation()`. See the function's doc comment
 * for the contract on each field.
 */
export interface CloneForMutationResult<T extends FabricValue> {
  /**
   * Replacement for the caller's input value, with the spine to `path` made
   * mutable. Identical to the input by reference iff no clone was necessary
   * (only possible when `force: false` and the input's spine was already
   * mutable throughout).
   */
  value: T;

  /**
   * The value at `path` in the result tree, guaranteed mutable. The caller
   * mutates this directly to perform their structured-mutation operation
   * (property set/delete, array push/splice/set-element, ...). For a plain
   * object or array at `path`, `pathValue` is a shallow-thawed copy whose
   * own children remain identity-shared with the input. For a
   * `FabricInstance` at `path`, `pathValue` is its `shallowClone(false)`.
   */
  pathValue: FabricValue;
}

/**
 * Produces a view of `value` with the spine of containers along `path` made
 * mutable, so the caller can apply a structured mutation at `path` without
 * leaking changes back to the input. Subtrees off the spine retain their
 * identity (and their place in the deep-frozen cache) -- so a subsequent
 * `deepFreeze()` of the result tree short-circuits on every off-spine
 * subtree.
 *
 * Conceptually a copy-on-write descent: starting from the root, at each
 * step the next container along `path` is shallow-thawed (via
 * `cloneIfNecessary(_, { frozen: false, deep: false, force })`) and the
 * shallow clone is spliced into its (already-mutable) parent. The result
 * `pathValue` is the mutable container at the end of `path`.
 *
 * ### Mutation patterns supported via the returned `pathValue`
 *
 * - Object property add / set / delete: `pathValue.k = v`, `delete pathValue.k`.
 * - Array set-element / push / splice / length: `pathValue[i] = v`,
 *   `pathValue.push(v)`, `pathValue.splice(i, n, ...add)`, `pathValue.length = n`.
 * - "Replace the value at some slot": pass the parent's path as `path`,
 *   then assign through `pathValue[lastKey] = newValue`.
 *
 * ### Path semantics
 *
 * `path` is an array of pre-parsed segments (JSON-Pointer-style, but already
 * unescaped and split). Each segment is a property name for objects or an
 * array-index string for arrays. The helper descends through plain JS
 * objects and arrays; it does NOT descend into `FabricInstance` values
 * (those don't expose path-style member access in the current data model).
 * A `FabricInstance` is permitted as the final value at `path`, in which
 * case it's shallow-thawed via its own `shallowClone(false)` interface.
 *
 * ### Errors
 *
 * Throws if:
 * - A path segment names a missing slot on a plain container.
 * - An intermediate segment lands on something other than a plain object
 *   or array (a primitive, a `FabricInstance`, a `FabricPrimitive`, ...).
 * - The final segment lands on a value that isn't mutable-handle-able
 *   (a primitive or a `FabricPrimitive`).
 * - The root itself isn't mutable-handle-able and `path` is empty.
 * - The root isn't a plain container and `path` is non-empty.
 *
 * @param value - The input value tree.
 * @param path - Path to the container (or `FabricInstance`) to expose as
 *   mutable.
 * @param options - See `CloneForMutationOptions`.
 */
export function cloneForMutation<T extends FabricValue>(
  value: T,
  path: readonly string[],
  options?: CloneForMutationOptions,
): CloneForMutationResult<T> {
  const force = options?.force ?? true;
  // Used for every per-container shallow thaw along the spine, and for the
  // final value-at-`path` thaw if it's a plain container or `FabricInstance`.
  const cloneOpts = { frozen: false as const, deep: false as const, force };

  // --- Empty-path fast path ---------------------------------------------
  if (path.length === 0) {
    if (!isMutableHandle(value)) {
      throw new Error(
        `cloneForMutation: cannot mutate ${toDebugKindString(value)} at root ` +
          `(empty path)`,
      );
    }
    const newRoot = cloneIfNecessary(value, cloneOpts) as T;
    return { value: newRoot, pathValue: newRoot };
  }

  // --- Non-empty path ---------------------------------------------------
  // The root must be a plain container; descent through a `FabricInstance`
  // root would have nowhere to go (path-style access into FabricInstance
  // internals isn't supported).
  if (!isPlainContainer(value)) {
    throw new Error(
      `cloneForMutation: cannot descend into ${toDebugKindString(value)} at ` +
        `root (path has ${path.length} segment${path.length === 1 ? "" : "s"})`,
    );
  }

  const newRoot = cloneIfNecessary(value, cloneOpts) as T;
  // `current` is always a plain container at the top of each loop iteration:
  // we enter with `newRoot` (a plain container by the root check above) and
  // before descending we always type-check the next container.
  let current: Record<string, FabricValue> | FabricValue[] = newRoot as
    | Record<string, FabricValue>
    | FabricValue[];

  for (let i = 0; i < path.length; i++) {
    const key = path[i]!;
    const isLast = i === path.length - 1;

    if (!Object.hasOwn(current, key)) {
      throw new Error(
        `cloneForMutation: missing path segment ${JSON.stringify(key)} at ` +
          `index ${i}`,
      );
    }

    const next = (current as Record<string, FabricValue>)[key];

    if (isLast) {
      if (!isMutableHandle(next)) {
        throw new Error(
          `cloneForMutation: cannot mutate ${
            toDebugKindString(next)
          } at path ` +
            `index ${i} (final segment)`,
        );
      }
    } else {
      if (!isPlainContainer(next)) {
        throw new Error(
          `cloneForMutation: cannot descend into ${
            toDebugKindString(next)
          } at ` +
            `path index ${i}`,
        );
      }
    }

    // Shallow-thaw the next spine container. For plain containers and
    // `FabricInstance`s this is a `cloneIfNecessary(_, { frozen: false,
    // deep: false, force })` call; under `force: false` and an
    // already-mutable input it short-circuits to identity.
    const thawed = cloneIfNecessary(next as FabricValue, cloneOpts);
    if (thawed !== next) {
      (current as Record<string, FabricValue>)[key] = thawed;
    }

    if (isLast) {
      return { value: newRoot, pathValue: thawed };
    }

    // Type assertion safe: we type-checked `next` is a plain container,
    // and shallow-thaw preserves prototype, so `thawed` is also a plain
    // container.
    current = thawed as Record<string, FabricValue> | FabricValue[];
  }

  // Unreachable: the loop always returns on its final iteration when
  // `path.length > 0` (handled above for `path.length === 0`).
  /* c8 ignore next 3 */
  throw new Error("cloneForMutation: unreachable");
}

/**
 * Returns `true` when `cloneForMutation` can produce a mutable handle for
 * the value at `path`. Plain containers and `FabricInstance`s qualify;
 * primitives and `FabricPrimitive`s (which are immutable by construction)
 * do not.
 */
function isMutableHandle(value: unknown): boolean {
  return isPlainContainer(value) || value instanceof FabricInstance;
}
