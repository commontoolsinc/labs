import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { NodeRegistry } from "../../src/scheduler/node-record.ts";
import { topologicalSort } from "../../src/scheduler/topology.ts";
import type { Action } from "../../src/scheduler/types.ts";

/**
 * A registry that counts how often the sort reads an action's parent, which
 * is what the sort's cycle fallback spends when it runs over the whole
 * unvisited set at every break.
 */
class CountingRegistry extends NodeRegistry {
  parentLookups = 0;

  override parentActionOf(action: Action): Action | undefined {
    this.parentLookups++;
    return super.parentActionOf(action);
  }
}

/** `count` actions registered in order, each named by its index. */
function registerActions(
  nodes: NodeRegistry,
  count: number,
  parentOf?: (index: number) => number | undefined,
): Action[] {
  const actions: Action[] = [];
  for (let index = 0; index < count; index++) {
    const action: Action = () => {};
    Object.defineProperty(action, "name", { value: `a${index}` });
    actions.push(action);
    nodes.register(action, "computation");
  }
  for (let index = 0; index < count; index++) {
    const parent = parentOf?.(index);
    if (parent !== undefined) nodes.linkParent(actions[index], actions[parent]);
  }
  return actions;
}

/** The pull-mode data edges of a sort: `from` runs before each of `to`. */
function edges(
  pairs: readonly (readonly [Action, readonly Action[]])[],
): WeakMap<Action, Set<Action>> {
  const dependents = new WeakMap<Action, Set<Action>>();
  for (const [from, to] of pairs) dependents.set(from, new Set(to));
  return dependents;
}

const names = (order: readonly Action[]) => order.map((action) => action.name);

/**
 * The ordering rule stated directly, so the randomized case below holds the
 * sort to the rule rather than to itself: data edges first, a parent before
 * its child unless a data edge opposes it, registration order among the
 * ready, and at a cycle the unvisited action with no unvisited parent, the
 * lowest remaining in-degree, and the earliest registration, in that order
 * of preference. Written over the whole unvisited set at every break, which
 * is the cost the sort itself must not pay.
 */
function referenceOrder(
  actions: readonly Action[],
  dependents: WeakMap<Action, Set<Action>>,
  nodes: NodeRegistry,
): Action[] {
  const set = new Set(actions);
  const graph = new Map<Action, Set<Action>>();
  const inDegree = new Map<Action, number>();
  for (const action of actions) {
    graph.set(action, new Set());
    inDegree.set(action, 0);
  }
  for (const from of actions) {
    for (const to of dependents.get(from) ?? []) {
      graph.get(from)!.add(to);
      inDegree.set(to, inDegree.get(to)! + 1);
    }
  }
  for (const child of actions) {
    const parent = nodes.parentActionOf(child);
    if (!parent || !set.has(parent)) continue;
    if (graph.get(parent)!.has(child) || graph.get(child)!.has(parent)) {
      continue;
    }
    graph.get(parent)!.add(child);
    inDegree.set(child, inDegree.get(child)! + 1);
  }
  const ordinal = (action: Action) => nodes.getRegistrationOrdinal(action)!;
  const byRegistration = (a: Action, b: Action) => ordinal(a) - ordinal(b);
  const visited = new Set<Action>();
  const result: Action[] = [];
  let queue = actions.filter((action) => inDegree.get(action) === 0)
    .sort(byRegistration);
  while (queue.length > 0 || visited.size < actions.length) {
    if (queue.length === 0) {
      const blocked = (action: Action) => {
        const parent = nodes.parentActionOf(action);
        return parent !== undefined && set.has(parent) &&
          !visited.has(parent);
      };
      const unvisited = actions.filter((action) => !visited.has(action));
      unvisited.sort((a, b) => {
        if (blocked(a) !== blocked(b)) return blocked(a) ? 1 : -1;
        const byDegree = inDegree.get(a)! - inDegree.get(b)!;
        return byDegree !== 0 ? byDegree : byRegistration(a, b);
      });
      queue.push(unvisited[0]);
    }
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    result.push(current);
    for (const next of graph.get(current)!) {
      inDegree.set(next, inDegree.get(next)! - 1);
      if (inDegree.get(next) === 0) {
        queue = [...queue, next].sort(byRegistration);
      }
    }
  }
  return result;
}

/** A small deterministic generator, so a failing seed can be rerun. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("topologicalSort()", () => {
  describe("cycle fallback", () => {
    // Each case holds a read/write cycle the sort cannot order by edges,
    // and a competitor that the fallback's preference order decides against
    // or for. The expected orders are worked out by hand from the rule.

    it("prefers an action whose parent is visited over an earlier-registered action whose parent is not", () => {
      const nodes = new NodeRegistry();
      // `a0` is the child of `a1`, registered first.
      const [child, parent] = registerActions(
        nodes,
        2,
        (index) => index === 0 ? 1 : undefined,
      );
      const order = topologicalSort(
        new Set([child, parent]),
        new WeakMap(),
        new WeakMap(),
        nodes,
        edges([[child, [parent]], [parent, [child]]]),
      );

      expect(names(order)).toEqual(["a1", "a0"]);
    });

    it("prefers the lowest remaining in-degree over registration order", () => {
      const nodes = new NodeRegistry();
      const [a0, a1, a2, a3] = registerActions(nodes, 4);
      // `a0`/`a1` and `a2`/`a3` are cycles, and `a3` also feeds `a0`, so at
      // the first break `a0` alone has in-degree two and `a1` runs first
      // although `a0` registered first.
      const order = topologicalSort(
        new Set([a0, a1, a2, a3]),
        new WeakMap(),
        new WeakMap(),
        nodes,
        edges([[a0, [a1]], [a1, [a0]], [a2, [a3]], [a3, [a2, a0]]]),
      );

      expect(names(order)).toEqual(["a1", "a0", "a2", "a3"]);
    });

    it("breaks ties of parent state and in-degree by registration order", () => {
      const nodes = new NodeRegistry();
      const [a0, a1, a2, a3] = registerActions(nodes, 4);
      // Two independent cycles with equal in-degrees: registration order
      // picks `a0`, and the second break then picks `a2` over `a3`.
      const order = topologicalSort(
        new Set([a3, a2, a1, a0]),
        new WeakMap(),
        new WeakMap(),
        nodes,
        edges([[a0, [a1]], [a1, [a0]], [a2, [a3]], [a3, [a2]]]),
      );

      expect(names(order)).toEqual(["a0", "a1", "a2", "a3"]);
    });

    it("picks at a later break by the in-degrees the visits before it left", () => {
      const nodes = new NodeRegistry();
      const [a0, a1, a2, a3] = registerActions(nodes, 4);
      // `a0`/`a1` cycle, `a2`/`a3` cycle, and `a1` feeds `a2`: the first
      // break picks `a0`; after `a1` runs, `a2`'s in-degree falls to one and
      // ties with `a3`, so registration order picks `a2`.
      const order = topologicalSort(
        new Set([a0, a1, a2, a3]),
        new WeakMap(),
        new WeakMap(),
        nodes,
        edges([[a0, [a1]], [a1, [a0, a2]], [a2, [a3]], [a3, [a2]]]),
      );

      expect(names(order)).toEqual(["a0", "a1", "a2", "a3"]);
    });

    it("orders random cyclic work sets as the rule stated directly does", () => {
      for (let seed = 1; seed <= 40; seed++) {
        const random = lcg(seed);
        const nodes = new NodeRegistry();
        const count = 60 + Math.floor(random() * 140);
        const actions = registerActions(
          nodes,
          count,
          (index) =>
            index > 0 && random() < 0.4
              ? Math.floor(random() * index)
              : undefined,
        );
        const pairs: [Action, Action[]][] = actions.map((from) => {
          const to: Action[] = [];
          const fanOut = Math.floor(random() * 3);
          for (let n = 0; n < fanOut; n++) {
            const target = actions[Math.floor(random() * count)];
            if (target !== from) to.push(target);
          }
          return [from, to];
        });
        const dependents = edges(pairs);
        const shuffled = [...actions].sort(() => random() - 0.5);

        const order = topologicalSort(
          new Set(shuffled),
          new WeakMap(),
          new WeakMap(),
          nodes,
          dependents,
        );

        expect(names(order), `seed ${seed}`).toEqual(
          names(referenceOrder(shuffled, dependents, nodes)),
        );
      }
    });

    it("reads each action's parent once while breaking thousands of cycles", () => {
      // Pairs of mutually dependent actions, so every pair is a break: the
      // fallback that re-sorts the unvisited set at each break reads a
      // parent for every comparison, millions of times over this set.
      const nodes = new CountingRegistry();
      const count = 4000;
      const actions = registerActions(nodes, count);
      const pairs: [Action, Action[]][] = [];
      for (let index = 0; index < count; index += 2) {
        pairs.push([actions[index], [actions[index + 1]]]);
        pairs.push([actions[index + 1], [actions[index]]]);
      }

      const order = topologicalSort(
        new Set(actions),
        new WeakMap(),
        new WeakMap(),
        nodes,
        edges(pairs),
      );

      expect(order).toEqual(actions);
      expect(nodes.parentLookups).toBe(count);
    });
  });
});
