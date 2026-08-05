import type { FabricExecValue } from "@commonfabric/api";
import { isFabricExecPlainObject } from "@commonfabric/data-model/fabric-value";
import { isFunction, isRecord } from "@commonfabric/utils/types";

/**
 * Decides what a walk does with each value it meets. Each member is a question
 * the walk cannot settle for itself, because settling it is what distinguishes
 * one walk from another: which values stand for something else, what a
 * container becomes on the way in, and what a cycle looks like once found.
 */
export type Replacer<In, Out> = {
  /**
   * Returns what stands in for `value`, or `undefined` to let the walk carry
   * on with it. What this returns is never descended into.
   *
   * This is where a walk names the type it exists to replace -- a cell by the
   * link that reaches it, say. It may also throw, which is how a walk refuses
   * a value it cannot represent.
   */
  replace(value: In): { value: Out } | undefined;

  /**
   * Returns what stands in for a value the walk is already inside, which is to
   * say a cycle. `path` locates that value from the root of the walk, for a
   * caller that represents it with a reference.
   */
  cycle(value: object, path: readonly string[]): Out;

  /**
   * Returns the container to descend into, given one the walk is about to
   * descend into -- or `{ value }` to stop there and stand for it with that
   * instead. A walk that transforms containers on the way in does it here.
   */
  enter?(value: object): { into: In } | { value: Out };
};

/**
 * Helper for `replacingWalk()`, which indicates whether a value's members are
 * reached by NAME, that being the only way the walk descends.
 *
 * A `FabricSpecialObject` is not: a `FabricPrimitive` keeps its state in
 * private fields and a `FabricInstance` in its codec contents, so rebuilding
 * either from its enumerable members yields `{}`. Neither is a native the
 * caller left alone, a `Date` having nothing to find by name either.
 *
 * The cast is the walk being generic: it cannot know how a caller's `In`
 * relates to `FabricExecValue`, and this asks a question about the value's
 * shape that holds whatever the caller calls it.
 */
function isNameWalkable(value: unknown): boolean {
  return isFabricExecPlainObject(value as FabricExecValue) ||
    Array.isArray(value);
}

/**
 * Helper for `replacingWalk()`, which types a value the walk hands back without
 * having replaced it: one no `Replacer` claimed, or a container rebuilt from
 * members it already walked.
 *
 * Whether those really are `Out` is the `Replacer`'s guarantee rather than
 * anything the walk can check. It holds when the replacer covers every input
 * that is not already an output -- a cell, a handler -- which is the whole of
 * what a replacer is for, and is not a claim a type can carry.
 */
function asOut<Out>(value: unknown): Out {
  return value as Out;
}

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
 * `In` and `Out` differ, and saying so is the point. What arrives holds the
 * things a walk exists to remove -- a `Cell`, a handler, a native awaiting
 * conversion -- and what leaves does not. A caller names both: the runtime's
 * walk takes what a pattern produced and yields fabric values and links, while
 * the client's takes handles and yields refs.
 *
 * @param value The value to walk.
 * @param replacer Decides what becomes of the values met along the way.
 * @param path Where `value` sits, from the root of the walk.
 * @param ancestors The values the walk is currently inside, by their paths.
 */
export function replacingWalk<In, Out>(
  value: In,
  replacer: Replacer<In, Out>,
  path: readonly string[] = [],
  ancestors: Map<object, readonly string[]> = new Map(),
): Out {
  if ((isRecord(value) || isFunction(value)) && ancestors.has(value)) {
    return replacer.cycle(value, ancestors.get(value)!);
  }

  const replaced = replacer.replace(value);
  if (replaced !== undefined) return replaced.value;

  // Anything object-ish is offered to `enter`, since a caller may have a
  // transformation for one -- a native `Uint8Array` becoming a `FabricBytes`,
  // say. What may be DESCENDED into is decided after that, below.
  if (!(isRecord(value) || isFunction(value))) return asOut(value);

  const original = value;
  ancestors.set(original, path);
  try {
    const entered = replacer.enter?.(original) ?? { into: original };
    if ("value" in entered) return entered.value;
    const into = entered.into;

    // TODO(danfuzz): a `FabricInstance` stands whole here, and it is not
    // really a leaf -- it is a container reached by its codec contents, so a
    // cell inside one is missed. Descending one wants codec-mediated
    // traversal, the same gap marked at the sibling walks
    // (`traverseAndCellify` in `builtins/llm-dialog.ts`, `data-uri.ts`).
    if (!isNameWalkable(into)) return asOut(into);

    if (Array.isArray(into)) {
      return asOut(
        into.map((element: In, index: number) =>
          replacingWalk(element, replacer, [...path, String(index)], ancestors)
        ),
      );
    }
    return asOut(
      Object.fromEntries(
        Object.entries(into as Record<string, In>).map(([key, member]) => [
          key,
          replacingWalk(member, replacer, [...path, key], ancestors),
        ]),
      ),
    );
  } finally {
    ancestors.delete(original);
  }
}
