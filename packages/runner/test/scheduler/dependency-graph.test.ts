import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type DependencyGraphState,
  groupReadsByEntity,
  isLive,
  livenessWork,
  notifyNodeLivenessChange,
  recomputeLiveRefs,
  registerDependentEdge,
  resetLivenessWork,
  setNodeProvisionalDemand,
  unregisterDependentEdge,
} from "../../src/scheduler/dependency-graph.ts";
import { NodeRegistry } from "../../src/scheduler/node-record.ts";
import type { Action } from "../../src/scheduler/types.ts";

/**
 * A liveness graph with a materializer set a test can toggle, the way the
 * production index is toggled by registration.
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

  /** Change materializer status the way `SchedulerMaterializers` does. */
  const setMaterializer = (action: Action, value: boolean): void => {
    const record = nodes.get(action);
    const wasLive = record ? isLive(state, record) : false;
    if (value) materializers.add(action);
    else materializers.delete(action);
    notifyNodeLivenessChange(state, action, wasLive);
  };

  const toggleMaterializer = (action: Action): void =>
    setMaterializer(action, !materializers.has(action));

  return { nodes, state, setMaterializer, toggleMaterializer };
}

/**
 * Compare the incrementally maintained refcounts against a rebuild from the
 * demand roots, which is the definition they implement. The rebuild overwrites,
 * so each step is checked against a correct prior state.
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

function named(name: string): Action {
  return { [name]: () => {} }[name];
}

describe("dependency-graph", () => {
  describe("liveness work counters", () => {
    it("resets every liveness work counter", () => {
      livenessWork.nodeWrites = 3;
      livenessWork.edgeVisits = 4;
      livenessWork.operations = 5;

      resetLivenessWork();

      expect(livenessWork).toEqual({
        nodeWrites: 0,
        edgeVisits: 0,
        operations: 0,
      });
    });
  });

  describe("groupReadsByEntity()", () => {
    it("keeps paths for the same entity together", () => {
      const first = {
        space: "did:key:space" as const,
        scope: "space" as const,
        id: "of:first" as const,
        path: ["a"],
      };
      const second = { ...first, path: ["b"] };
      const third = { ...first, id: "of:second" as const, path: [] };

      expect([...groupReadsByEntity([first, second, third]).values()]).toEqual([
        [first, second],
        [third],
      ]);
    });
  });

  describe("registerDependentEdge()", () => {
    it("gives the writer a reference when the reader is live", () => {
      const { nodes, state } = createGraph();
      const writer = named("writer");
      const reader = named("reader");
      nodes.register(writer, "computation");
      nodes.register(reader, "effect");

      registerDependentEdge(state, writer, reader);

      expect(nodes.get(writer)?.liveRefs).toBe(1);
      expect(isLive(state, nodes.get(writer)!)).toBe(true);
    });

    it("gives the writer no reference when the reader is not live", () => {
      const { nodes, state } = createGraph();
      const writer = named("writer");
      const reader = named("reader");
      nodes.register(writer, "computation");
      nodes.register(reader, "computation");

      registerDependentEdge(state, writer, reader);

      expect(nodes.get(writer)?.liveRefs).toBe(0);
      expect(isLive(state, nodes.get(writer)!)).toBe(false);
    });

    it("carries demand upstream through a chain when the far end becomes live", () => {
      const { nodes, state } = createGraph();
      const source = named("source");
      const middle = named("middle");
      const sink = named("sink");
      nodes.register(source, "computation");
      nodes.register(middle, "computation");
      nodes.register(sink, "effect");

      // Wire from the inactive end, so demand only arrives with the last edge.
      registerDependentEdge(state, source, middle);
      expect(isLive(state, nodes.get(source)!)).toBe(false);

      registerDependentEdge(state, middle, sink);

      expect(nodes.get(middle)?.liveRefs).toBe(1);
      expect(nodes.get(source)?.liveRefs).toBe(1);
      expect(isLive(state, nodes.get(source)!)).toBe(true);
    });

    it("stops downstream demand at a dormant writer", () => {
      const { nodes, state } = createGraph();
      const source = named("source");
      const middle = named("middle");
      const sink = named("sink");
      nodes.register(source, "computation");
      nodes.register(middle, "computation", undefined, { dormant: true });
      nodes.register(sink, "effect");
      registerDependentEdge(state, source, middle);

      registerDependentEdge(state, middle, sink);

      expect(nodes.get(middle)?.liveRefs).toBe(1);
      expect(nodes.get(source)?.liveRefs).toBe(0);
      expect(isLive(state, nodes.get(middle)!)).toBe(false);
      expect(isLive(state, nodes.get(source)!)).toBe(false);
      expectMatchesFullRebuild(state, "demand added below dormant node");

      nodes.register(middle, "computation", undefined, { dormant: false });
      notifyNodeLivenessChange(state, middle, false);
      expect(nodes.get(source)?.liveRefs).toBe(1);
      expect(isLive(state, nodes.get(source)!)).toBe(true);
      expectMatchesFullRebuild(state, "dormant node activated");
    });

    it("does not count a dormant reader in an independently live branch", () => {
      const { nodes, state } = createGraph();
      const source = named("source");
      const middle = named("middle");
      const sink = named("sink");
      const directReader = named("directReader");
      nodes.register(source, "computation");
      nodes.register(middle, "computation", undefined, { dormant: true });
      nodes.register(sink, "effect");
      nodes.register(directReader, "effect");
      registerDependentEdge(state, source, middle);
      registerDependentEdge(state, middle, sink);
      registerDependentEdge(state, source, directReader);

      expect(nodes.get(middle)?.liveRefs).toBe(1);
      expect(nodes.get(source)?.liveRefs).toBe(1);
      expectMatchesFullRebuild(state, "dormant branch beside live branch");
      expect(nodes.get(source)?.liveRefs).toBe(1);
    });
  });

  describe("unregisterDependentEdge()", () => {
    it("drops the reference a departing reader held on a root writer", () => {
      const { nodes, state } = createGraph();
      // An effect can itself be read, so its refcount has to stay accurate even
      // though its own liveness never depends on it.
      const writer = named("rootWriter");
      const reader = named("reader");
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
      const shared = named("shared");
      const keptReader = named("keptReader");
      const lostReader = named("lostReader");
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

  describe("notifyNodeLivenessChange()", () => {
    it("withdraws and restores demand with subscription dormancy", () => {
      const { nodes, state } = createGraph();
      const writer = named("writer");
      const reader = named("reader");
      nodes.register(writer, "computation");
      nodes.register(reader, "effect");
      registerDependentEdge(state, writer, reader);
      expect(nodes.get(writer)?.liveRefs).toBe(1);

      nodes.register(reader, "effect", undefined, { dormant: true });
      notifyNodeLivenessChange(state, reader, true);
      expect(nodes.get(writer)?.liveRefs).toBe(0);
      expect(isLive(state, nodes.get(reader)!)).toBe(false);

      nodes.register(reader, "effect", undefined, { dormant: false });
      notifyNodeLivenessChange(state, reader, false);
      expect(nodes.get(writer)?.liveRefs).toBe(1);
      expect(isLive(state, nodes.get(reader)!)).toBe(true);
    });

    it("withdraws upstream demand when a demanded node becomes dormant", () => {
      const { nodes, state } = createGraph();
      const source = named("source");
      const middle = named("middle");
      const sink = named("sink");
      nodes.register(source, "computation");
      nodes.register(middle, "computation");
      nodes.register(sink, "effect");
      registerDependentEdge(state, source, middle);
      registerDependentEdge(state, middle, sink);
      expect(nodes.get(source)?.liveRefs).toBe(1);

      nodes.register(middle, "computation", undefined, { dormant: true });
      notifyNodeLivenessChange(state, middle, true);

      expect(nodes.get(middle)?.liveRefs).toBe(1);
      expect(nodes.get(source)?.liveRefs).toBe(0);
      expect(isLive(state, nodes.get(middle)!)).toBe(false);
      expect(isLive(state, nodes.get(source)!)).toBe(false);
      expectMatchesFullRebuild(state, "demanded node made dormant");

      nodes.register(middle, "computation", undefined, { dormant: false });
      notifyNodeLivenessChange(state, middle, false);
      expect(nodes.get(source)?.liveRefs).toBe(1);
      expect(isLive(state, nodes.get(source)!)).toBe(true);
      expectMatchesFullRebuild(state, "demanded node reactivated");
    });

    it("carries demand upstream when an inactive node becomes a materializer", () => {
      const { nodes, state, setMaterializer } = createGraph();
      const source = named("source");
      const materializer = named("materializer");
      nodes.register(source, "computation");
      nodes.register(materializer, "computation");
      registerDependentEdge(state, source, materializer);
      expect(nodes.get(source)?.liveRefs).toBe(0);

      setMaterializer(materializer, true);

      expect(nodes.get(source)?.liveRefs).toBe(1);
      expect(isLive(state, nodes.get(source)!)).toBe(true);
    });

    it("releases a cycle that loses its last materializer root", () => {
      const { nodes, state, setMaterializer } = createGraph();
      // The two read each other, so each holds a reference from the other. Only
      // a walk from the remaining roots can tell that support apart from a
      // rootless cycle propping itself up.
      const root = named("cycleRoot");
      const other = named("cycleOther");
      nodes.register(root, "computation");
      nodes.register(other, "computation");
      setMaterializer(root, true);
      registerDependentEdge(state, root, other);
      registerDependentEdge(state, other, root);
      expect(isLive(state, nodes.get(other)!)).toBe(true);

      setMaterializer(root, false);

      expect(nodes.get(root)?.liveRefs).toBe(0);
      expect(nodes.get(other)?.liveRefs).toBe(0);
      expect(isLive(state, nodes.get(root)!)).toBe(false);
      expect(isLive(state, nodes.get(other)!)).toBe(false);
    });

    it("recovers the references a registering node's live readers already hold", () => {
      const { nodes, state } = createGraph();
      // Edges can name a node before it registers, and a reference is only
      // granted while the writer is registered, so registration has to collect
      // what its readers already owe it.
      const writer = named("writer");
      const reader = named("reader");
      nodes.register(reader, "effect");
      registerDependentEdge(state, writer, reader);
      expect(nodes.get(writer)).toBeUndefined();

      nodes.register(writer, "computation");
      notifyNodeLivenessChange(state, writer, false);

      expect(nodes.get(writer)?.liveRefs).toBe(1);
      expect(isLive(state, nodes.get(writer)!)).toBe(true);
    });

    it("passes a recovered registration's demand further upstream", () => {
      const { nodes, state } = createGraph();
      const source = named("source");
      const middle = named("middle");
      const reader = named("reader");
      nodes.register(source, "computation");
      nodes.register(reader, "effect");
      registerDependentEdge(state, source, middle);
      registerDependentEdge(state, middle, reader);
      expect(nodes.get(source)?.liveRefs).toBe(0);

      nodes.register(middle, "computation");
      notifyNodeLivenessChange(state, middle, false);

      expect(nodes.get(middle)?.liveRefs).toBe(1);
      expect(nodes.get(source)?.liveRefs).toBe(1);
    });
  });

  describe("incremental maintenance", () => {
    // Which roots a run is allowed to create decides which shapes it can reach.
    // A run that registers effects makes almost every node root-reachable, so
    // rootless cycles never form and the release path goes unexercised; the
    // root-free runs below are the ones that reach it.
    const runs = [
      { name: "with effect roots", effectShare: 0.25, provisional: true },
      { name: "with no effect roots", effectShare: 0, provisional: true },
      {
        name: "with materializer roots only",
        effectShare: 0,
        provisional: false,
      },
    ];

    for (const run of runs) {
      it(`matches a full rebuild after every mutation ${run.name}`, () => {
        for (let seed = 1; seed <= 20; seed++) {
          const random = createRandom(seed * 7919);
          const { nodes, state, toggleMaterializer } = createGraph();
          const actions: Action[] = [];
          for (let i = 0; i < 10; i++) {
            const action = named(`node${i}`);
            actions.push(action);
            nodes.register(
              action,
              random() < run.effectShare ? "effect" : "computation",
            );
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
            } else if (roll < 0.9 && run.provisional) {
              const record = nodes.get(writer)!;
              setNodeProvisionalDemand(
                state,
                record,
                !record.provisionalDemand,
              );
            } else {
              toggleMaterializer(writer);
            }
            expectMatchesFullRebuild(
              state,
              `${run.name} seed ${seed} step ${step}`,
            );
          }
        }
      });
    }

    it("matches a full rebuild when edges are wired before their writer registers", () => {
      for (let seed = 1; seed <= 20; seed++) {
        const random = createRandom(seed * 104729);
        const { nodes, state } = createGraph();
        const actions: Action[] = [];
        for (let i = 0; i < 8; i++) actions.push(named(`late${i}`));
        // One standing root, so demand has somewhere to come from.
        nodes.register(actions[0], "effect");
        const pick = () => actions[Math.floor(random() * actions.length)];

        for (let step = 0; step < 200; step++) {
          const roll = random();
          const target = pick();
          if (roll < 0.5) {
            registerDependentEdge(state, pick(), pick());
          } else if (roll < 0.8) {
            unregisterDependentEdge(state, pick(), pick());
          } else if (!nodes.get(target)) {
            nodes.register(target, "computation");
            notifyNodeLivenessChange(state, target, false);
          }
          expectMatchesFullRebuild(state, `late seed ${seed} step ${step}`);
        }
      }
    });
  });
});
