import { FabricInstance, FabricPrimitive, FabricValue } from "./interface.ts";
import { NATIVE_TAGS, tagFromNativeValue } from "./native-type-tags.ts";
import { isDeepFrozen, isDeepFrozenFabricValue } from "./deep-freeze.ts";
import {
  type Immutable,
  isPlainContainer,
  isPlainObject,
} from "@commonfabric/utils/types";
import { toDebugKindString } from "./value-debug.ts";
import { isArrayIndexPropertyName } from "./array-utils.ts";

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
 * Categorical kinds of error that `cloneForMutation()` can fail with.
 *
 * - `"non-mutable-root"` — empty `path` and the root value isn't a kind
 *   for which a mutable handle exists (a primitive, a `FabricPrimitive`,
 *   etc.).
 * - `"non-container-root"` — non-empty `path` and the root isn't a plain
 *   object or array, so there's nothing to descend into.
 * - `"missing-segment"` — a `path` segment names a slot that doesn't
 *   exist on its container, and `createMissing` is `false`.
 * - `"non-container-descent"` — an intermediate segment lands on a value
 *   that isn't a plain object or array, so descent can't continue.
 * - `"non-mutable-leaf"` — the final segment lands on a value for which
 *   no mutable handle exists (a primitive or `FabricPrimitive`).
 */
export type CloneForMutationErrorKind =
  | "non-mutable-root"
  | "non-container-root"
  | "missing-segment"
  | "non-container-descent"
  | "non-mutable-leaf";

/**
 * Error thrown by `cloneForMutation()` when the input value or path is
 * unsuitable for producing a mutable handle. Carries structured fields so
 * the caller can preserve typed error info rather than parsing the
 * message.
 *
 * - `kind` — categorical reason (see {@link CloneForMutationErrorKind}).
 * - `pathIndex` — the path index at which the error occurred, or `-1`
 *   for root-level errors.
 * - `valueKind` — debug-string kind of the offending value (matches
 *   `toDebugKindString()`).
 */
export class CloneForMutationError extends Error {
  constructor(
    readonly kind: CloneForMutationErrorKind,
    readonly pathIndex: number,
    readonly valueKind: string,
    message: string,
  ) {
    super(message);
    this.name = "CloneForMutationError";
  }
}

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

  /**
   * Create missing intermediate containers along `path` as the helper
   * descends. Default: `false` (throws `CloneForMutationError` with kind
   * `"missing-segment"` on the first missing slot).
   *
   * When `createMissing: true`, at each path step where the container at
   * that key is absent, the helper allocates a fresh container and
   * splices it into its parent before descending. The new container's
   * shape (array vs. plain object) is chosen from the NEXT segment that
   * will be used as a key against it:
   *
   * - For intermediate path steps, the next segment is `path[i+1]`.
   * - For the final path step, the next segment is `nextKeyAfterPath` if
   *   supplied; otherwise the empty string (which selects a plain object).
   *
   * Array-index-shaped keys (`isArrayIndexPropertyName(key)`) and the
   * JSON-Pointer append marker `"-"` select an array; everything else
   * selects a plain object.
   */
  createMissing?: boolean;

  /**
   * Hint for the container shape to create at the final path step when
   * it's missing and `createMissing: true`. Should be the next key the
   * caller intends to access against the value-at-path. Ignored when
   * `createMissing: false` or when the final path step already exists.
   * Default: `""` (selects a plain object).
   *
   * Same shape-selection rule as for intermediate steps: array-index-
   * shaped values (per `isArrayIndexPropertyName`) and the JSON-Pointer
   * append marker `"-"` select an array; everything else selects a
   * plain object.
   *
   * Mirrors `v2-path.ensureParentContainers`'s `lastKey` parameter.
   */
  nextKeyAfterPath?: string;
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
 * ### Missing path segments
 *
 * By default (`createMissing: false`), missing segments throw a
 * `CloneForMutationError` with kind `"missing-segment"`. With
 * `createMissing: true`, the helper allocates fresh containers as it
 * descends through missing slots; see {@link CloneForMutationOptions} for
 * the shape-selection rules (in particular the `nextKeyAfterPath` hint).
 *
 * ### Errors
 *
 * Throws a `CloneForMutationError` (see {@link CloneForMutationErrorKind})
 * for unsuitable inputs or paths. Other unexpected errors (e.g. cycles in
 * the spine surfaced by the underlying `cloneIfNecessary` machinery)
 * propagate as plain `Error`s.
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
  const createMissing = options?.createMissing ?? false;
  const nextKeyAfterPath = options?.nextKeyAfterPath ?? "";
  // Used for every per-container shallow thaw along the spine, and for the
  // final value-at-`path` thaw if it's a plain container or `FabricInstance`.
  const cloneOpts = { frozen: false as const, deep: false as const, force };

  // --- Empty-path fast path ---------------------------------------------
  if (path.length === 0) {
    if (!isMutableHandle(value)) {
      throw new CloneForMutationError(
        "non-mutable-root",
        -1,
        toDebugKindString(value),
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
    throw new CloneForMutationError(
      "non-container-root",
      -1,
      toDebugKindString(value),
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

    let next: FabricValue;
    if (Object.hasOwn(current, key)) {
      next = (current as Record<string, FabricValue>)[key];
    } else if (createMissing) {
      // Allocate a fresh container at this slot. Its shape comes from the
      // next key that will be used against it: `path[i+1]` for
      // intermediate steps, `nextKeyAfterPath` for the final step.
      const nextKey = isLast ? nextKeyAfterPath : path[i + 1]!;
      next = createMissingContainer(nextKey);
      (current as Record<string, FabricValue>)[key] = next;
      // `next` is freshly allocated and already mutable; skip the
      // shallow-thaw step below.
      if (isLast) return { value: newRoot, pathValue: next };
      current = next as Record<string, FabricValue> | FabricValue[];
      continue;
    } else {
      throw new CloneForMutationError(
        "missing-segment",
        i,
        "undefined",
        `cloneForMutation: missing path segment ${JSON.stringify(key)} at ` +
          `index ${i}`,
      );
    }

    if (isLast) {
      if (!isMutableHandle(next)) {
        throw new CloneForMutationError(
          "non-mutable-leaf",
          i,
          toDebugKindString(next),
          `cloneForMutation: cannot mutate ${
            toDebugKindString(next)
          } at path ` +
            `index ${i} (final segment)`,
        );
      }
    } else {
      if (!isPlainContainer(next)) {
        throw new CloneForMutationError(
          "non-container-descent",
          i,
          toDebugKindString(next),
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
 * Allocates a fresh, mutable container of the right shape for `nextKey`.
 * Array-index-shaped keys (per `isArrayIndexPropertyName`) and the
 * JSON-Pointer append marker `"-"` produce an array; everything else
 * produces a plain object.
 */
function createMissingContainer(
  nextKey: string,
): Record<string, FabricValue> | FabricValue[] {
  return isArrayIndexPropertyName(nextKey) || nextKey === "-" ? [] : {};
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

// =============================================================================
// `cloneForIsolation`
// =============================================================================

/**
 * Produces a deep clone of `value` that is isolated from later mutations to
 * the source, with one targeted optimization: already-deep-frozen subtrees
 * are preserved by identity rather than re-cloned. This makes the dominant
 * "everything is already deep-frozen" case (common in modern data model,
 * where the storage layer hands back deep-frozen values) an O(1)
 * cache-lookup-and-return; partially-frozen trees only copy their mutable
 * portions.
 *
 * Dispatch:
 *
 * - Primitives are returned as-is.
 * - Already-deep-frozen values (per `isDeepFrozen`, which uses the
 *   `[IS_DEEP_FROZEN]` protocol for `FabricInstance`) are returned by
 *   identity at any level of the recursion. This is the perf
 *   optimization the simpler `cloneIfNecessary(_, { frozen: false })`
 *   doesn't have (it `force: true`s a full deep clone).
 * - `FabricPrimitive` instances are returned as-is (immutable by
 *   construction; their frozenness is irrelevant).
 * - `FabricInstance` instances are deep-cloned via `.deepClone(false)`
 *   (whose own semantics govern any nested values inside the wrapper).
 * - Plain objects and arrays are deep-cloned recursively, with cycle
 *   detection.
 * - Any other class instance is a `FabricValue` type violation upstream;
 *   the function throws.
 *
 * Result mutability: the returned tree is mutable along any path that
 * wasn't already deep-frozen in the input; deep-frozen subtrees inside
 * the result remain frozen by reference. Callers that need a uniformly
 * mutable result should use `cloneIfNecessary(value, { frozen: false })`.
 *
 * Intended use: snapshotting and write-isolation paths where the goal is
 * "the result is independent of any subsequent mutation to the source"
 * but the caller doesn't itself mutate the result. (The storage layer's
 * read freezing and patch-intent recording are the canonical consumers.)
 */
export function cloneForIsolation<T extends FabricValue>(value: T): T {
  return cloneForIsolationHelper(value, new Map()) as T;
}

function cloneForIsolationHelper(
  value: FabricValue,
  seen: Map<object, FabricValue>,
): FabricValue {
  if (value === null || typeof value !== "object") {
    return value;
  }

  // Optimization: already-deep-frozen subtrees are immutable, so the
  // source reference is safe to share with the caller.
  if (isDeepFrozen(value)) {
    return value;
  }

  const cached = seen.get(value);
  if (cached !== undefined) {
    return cached;
  }

  if (Array.isArray(value)) {
    const copy: FabricValue[] = new Array(value.length);
    seen.set(value, copy);
    for (let i = 0; i < value.length; i++) {
      if (i in value) {
        copy[i] = cloneForIsolationHelper(value[i], seen);
      }
    }
    return copy;
  }

  if (isPlainObject(value)) {
    // Preserve null prototypes (e.g. `Object.create(null)`).
    const proto = Object.getPrototypeOf(value);
    const copy = Object.create(proto) as Record<PropertyKey, FabricValue>;
    seen.set(value, copy);
    const obj = value as Record<PropertyKey, FabricValue>;
    for (const key of Reflect.ownKeys(obj)) {
      copy[key] = cloneForIsolationHelper(obj[key], seen);
    }
    return copy;
  }

  // The only legal non-plain-prototype values inside a FabricValue are
  // FabricPrimitive (immutable by construction; return as-is) and
  // FabricInstance (delegate to its own clone protocol).
  if (value instanceof FabricPrimitive) {
    return value;
  }
  if (value instanceof FabricInstance) {
    return (value as FabricInstance).deepClone(false) as FabricValue;
  }

  throw new Error(
    `cloneForIsolation: unexpected non-FabricValue (${
      toDebugKindString(value)
    })`,
  );
}
