import type { FabricExecValue } from "@commonfabric/api";
import { isFabricExecPlainObject } from "@commonfabric/data-model/fabric-value";
import { isFunction, isRecord } from "@commonfabric/utils/types";

/**
 * Decides what a walk does with each value it meets. Each member is a question
 * the walk cannot settle for itself, because settling it is what distinguishes
 * one walk from another: which values stand for something else, what a
 * container becomes on the way in, and what a cycle looks like once found.
 */
export type Replacer = {
  /**
   * Returns what stands in for `value`, or `undefined` to let the walk carry
   * on with it. What this returns is never descended into.
   *
   * This is where a walk names the type it exists to replace -- a cell by the
   * link that reaches it, say. It may also throw, which is how a walk refuses
   * a value it cannot represent.
   */
  replace(value: FabricExecValue): { value: FabricExecValue } | undefined;

  /**
   * Returns what stands in for a value the walk is already inside, which is to
   * say a cycle. `path` locates that value from the root of the walk, for a
   * caller that represents it with a reference.
   */
  cycle(value: object, path: readonly string[]): FabricExecValue;

  /**
   * Returns the container to descend into, given one the walk is about to
   * descend into -- or `{ value }` to stop there and stand for it with that
   * instead. A walk that transforms containers on the way in does it here.
   */
  enter?(value: object): { into: FabricExecValue } | { value: FabricExecValue };
};

/**
 * Walks a value, replacing what a caller names and rebuilding the containers
 * that held it.
 *
 * The walk tracks the ANCESTORS of the value it is on, so what it recognizes is
 * a cycle. A value reachable twice by different paths is not one: it is shared,
 * and each position is converted on its own. Treating a shared reference as a
 * cycle would rewrite one of its positions into a reference to the other.
 *
 * A container carrying nothing replaced still comes back rebuilt rather than by
 * identity. A caller wanting identity preserved can compare and discard.
 *
 * The domain is `FabricExecValue` rather than `FabricValue` on both sides: what
 * arrives may hold live things a durable value may not -- a `Cell`, a handler
 * -- which is the reason to walk it at all, and what a replacement stands in
 * with is a caller's business rather than this one's.
 *
 * @param value The value to walk.
 * @param replacer Decides what becomes of the values met along the way.
 * @param path Where `value` sits, from the root of the walk.
 * @param ancestors The values the walk is currently inside, by their paths.
 */
export function replacingWalk(
  value: FabricExecValue,
  replacer: Replacer,
  path: readonly string[] = [],
  ancestors: Map<object, readonly string[]> = new Map(),
): FabricExecValue {
  if ((isRecord(value) || isFunction(value)) && ancestors.has(value)) {
    return replacer.cycle(value, ancestors.get(value)!);
  }

  const replaced = replacer.replace(value);
  if (replaced !== undefined) return replaced.value;

  // Anything object-ish is offered to `enter`, since a caller may have a
  // transformation for one -- a native `Date` becoming a `FabricEpochNsec`,
  // say. What may be DESCENDED into is decided after that, below.
  if (!(isRecord(value) || isFunction(value))) return value;

  const original = value;
  ancestors.set(original, path);
  try {
    const entered = replacer.enter?.(original) ?? { into: original };
    if ("value" in entered) return entered.value;
    const into = entered.into;

    // Only a plain object or an array has members reached by NAME, which is
    // the only way this descends. A `FabricSpecialObject` therefore stands as
    // itself: a `FabricPrimitive` keeps its state in private fields and a
    // `FabricInstance` in its codec contents, so rebuilding either from its
    // enumerable members would yield `{}`. So does a native the caller left
    // alone, a `Date` having nothing to find by name either.
    //
    // TODO(danfuzz): a `FabricInstance` is not really a leaf -- it is a
    // container reached by its codec contents, and a cell inside one is missed
    // by standing it whole. Descending one wants codec-mediated traversal,
    // which is the same gap marked at the sibling walks (`traverseAndCellify`
    // in `builtins/llm-dialog.ts`, `data-uri.ts`).
    if (!isFabricExecPlainObject(into) && !Array.isArray(into)) return into;

    if (Array.isArray(into)) {
      return into.map((element, index) =>
        replacingWalk(
          element,
          replacer,
          [...path, String(index)],
          ancestors,
        )
      );
    }
    return Object.fromEntries(
      Object.entries(into).map(([key, member]) => [
        key,
        replacingWalk(member, replacer, [...path, key], ancestors),
      ]),
    );
  } finally {
    ancestors.delete(original);
  }
}
