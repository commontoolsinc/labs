import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type DependencyGraphState,
  isLive,
  notifyNodeLivenessChange,
  recomputeLiveRefs,
  registerDependentEdge,
  setNodeProvisionalDemand,
  unregisterDependentEdge,
} from "../src/scheduler/dependency-graph.ts";
import { NodeRegistry } from "../src/scheduler/node-record.ts";
import type { Action } from "../src/scheduler/types.ts";

/**
 * A liveness graph with a materializer set that a test can toggle, which the
 * production index maintains through registration.
 */
function createGraph() {
  const nodes = new NodeRegistry();
  const materializers = new Set<Action>();
  const state = {
    nodes,
    dependents: new WeakMap<Action, Set<Action>>(),
    reverseDependencies: new WeakMap<Action, Set<Action>>(),
    materializerIndex: {
      isMaterializer: (action: Action) => materializers.has(action),
    },
    getSchedulingWrites: () => undefined,
  } as unknown as DependencyGraphState;
  return { nodes, materializers, state };
}

/**
 * Compare the incrementally maintained refcounts against a rebuild from the
 * demand roots, which is the definition they implement.
 */
function expectMatchesFullRebuild(
  state: DependencyGraphState,
  label: string,
): void {
  const records = [...state.nodes.nodes()];
  const incremental = records.map((record) => ({
    action: record.action.name,
    liveRefs: record.liveRefs,
  }));
  recomputeLiveRefs(state);
  const rebuilt = records.map((record) => ({
    action: record.action.name,
    liveRefs: record.liveRefs,
  }));
  expect(incremental, label).toEqual(rebuilt);
}

/** Deterministic xorshift, so a failing sequence is reproducible. */
function createRandom(seed: number) {
  let value = seed;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    value >>>= 0;
    return value / 0x100000000;
  };
}

describe("dependency-graph", () => {
  describe("registerDependentEdge()", () => {
    it("gives the writer a reference when the reader is live", () => {
      const { nodes, state } = createGraph();
      const writer: Action = function writer() {};
      const reader: Action = function reader() {};
      nodes.register(writer, "computation");
      nodes.register(reader, "effect");

      registerDependentEdge(state, writer, reader);

      expect(nodes.get(writer)?.liveRefs).toBe(1);
      expect(isLive(state, nodes.get(writer)!)).toBe(true);
    });

    it("gives the writer no reference when the reader is dormant", () => {
      const { nodes, state } = createGraph();
      const writer: Action = function writer() {};
      const reader: Action = function reader() {};
      nodes.register(writer, "computation");
      nodes.register(reader, "computation");

      registerDependentEdge(state, writer, reader);

      expect(nodes.get(writer)?.liveRefs).toBe(0);
      expect(isLive(state, nodes.get(writer)!)).toBe(false);
    });

    it("carries demand upstream through a chain when the far end becomes live", () => {
      const { nodes, state } = createGraph();
      const source: Action = function source() {};
      const middle: Action = function middle() {};
      const sink: Action = function sink() {};
      nodes.register(source, "computation");
      nodes.register(middle, "computation");
      nodes.register(sink, "effect");

      // Wire the chain from the dormant end, so the demand only arrives with
      // the last edge.
      registerDependentEdge(state, source, middle);
      expect(isLive(state, nodes.get(source)!)).toBe(false);

      registerDependentEdge(state, middle, sink);

      expect(nodes.get(middle)?.liveRefs).toBe(1);
      expect(nodes.get(source)?.liveRefs).toBe(1);
      expect(isLive(state, nodes.get(source)!)).toBe(true);
    });
  });

  describe("unregisterDependentEdge()", () => {
    it("drops the reference a departing reader held on a root writer", () => {
      const { nodes, state } = createGraph();
      // An effect can itself be read, so its refcount has to stay accurate
      // even though its own liveness never depends on it.
      const writer: Action = function rootWriter() {};
      const reader: Action = function reader() {};
      nodes.register(writer, "effect");
      nodes.register(reader, "effect");
      registerDependentEdge(state, writer, reader);
      expect(nodes.get(writer)?.liveRefs).toBe(1);

      unregisterDependentEdge(state, writer, reader);

      expect(nodes.get(writer)?.liveRefs).toBe(0);
      expect(isLive(state, nodes.get(writer)!)).toBe(true);
    });

    it("leaves an unrelated branch untouched when a sibling branch dies", () => {
      const { nodes, state } = createGraph();
      const shared: Action = function shared() {};
      const keptReader: Action = function keptReader() {};
      const lostReader: Action = function lostReader() {};
      nodes.register(shared, "computation");
      nodes.register(keptReader, "effect");
      nodes.register(lostReader, "effect");
      registerDependentEdge(state, shared, keptReader);
      registerDependentEdge(state, shared, lostReader);

      unregisterDependentEdge(state, shared, lostReader);

      expect(nodes.get(shared)?.liveRefs).toBe(1);
      expect(isLive(state, nodes.get(shared)!)).toBe(true);
    });
  });

  describe("incremental maintenance", () => {
    it("matches a full rebuild after every mutation in a randomized sequence", () => {
      for (let seed = 1; seed <= 20; seed++) {
        const random = createRandom(seed * 7919);
        const { nodes, materializers, state } = createGraph();
        const actions: Action[] = [];
        for (let i = 0; i < 10; i++) {
          const action: Action = { [`node${i}`]: () => {} }[`node${i}`];
          actions.push(action);
          nodes.register(action, random() < 0.25 ? "effect" : "computation");
        }
        const pick = () => actions[Math.floor(random() * actions.length)];

        for (let step = 0; step < 300; step++) {
          const roll = random();
          const writer = pick();
          const reader = pick();
          if (roll < 0.4) {
            registerDependentEdge(state, writer, reader);
          } else if (roll < 0.75) {
            unregisterDependentEdge(state, writer, reader);
          } else if (roll < 0.9) {
            const record = nodes.get(writer)!;
            setNodeProvisionalDemand(state, record, !record.provisionalDemand);
          } else {
            // Materializer status changes outside the liveness code, which
            // then hears about it as a root transition.
            const wasLive = isLive(state, nodes.get(writer)!);
            if (materializers.has(writer)) {
              materializers.delete(writer);
            } else {
              materializers.add(writer);
            }
            notifyNodeLivenessChange(state, writer, wasLive);
          }
          expectMatchesFullRebuild(state, `seed ${seed} step ${step}`);
        }
      }
    });
  });
});
