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
  replace(value: unknown): { value: unknown } | undefined;

  /**
   * Returns what stands in for a value the walk is already inside, which is to
   * say a cycle. `path` locates that value from the root of the walk, for a
   * caller that represents it with a reference.
   */
  cycle(value: object, path: readonly string[]): unknown;

  /**
   * Returns the container to descend into, given one the walk is about to
   * descend into -- or `{ value }` to stop there and stand for it with that
   * instead. A walk that transforms containers on the way in does it here.
   */
  enter?(value: object): { into: object } | { value: unknown };
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
 * @param value The value to walk.
 * @param replacer Decides what becomes of the values met along the way.
 * @param path Where `value` sits, from the root of the walk.
 * @param ancestors The values the walk is currently inside, by their paths.
 */
export function replacingWalk(
  value: unknown,
  replacer: Replacer,
  path: readonly string[] = [],
  ancestors: Map<object, readonly string[]> = new Map(),
): unknown {
  if ((isRecord(value) || isFunction(value)) && ancestors.has(value)) {
    return replacer.cycle(value, ancestors.get(value)!);
  }

  const replaced = replacer.replace(value);
  if (replaced !== undefined) return replaced.value;

  // Only a container has members to walk. A function is offered to `enter`
  // alongside them, since a walk may have a replacement for one.
  if (!(isRecord(value) || isFunction(value))) return value;

  const original = value;
  ancestors.set(original, path);
  try {
    const entered = replacer.enter?.(original) ?? { into: original };
    if ("value" in entered) return entered.value;
    const into = entered.into;

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
