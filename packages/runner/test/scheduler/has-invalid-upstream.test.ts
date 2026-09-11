import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { hasInvalidUpstream } from "../../src/scheduler/dependency-graph.ts";
import { NodeRegistry } from "../../src/scheduler/node-record.ts";
import type { Action } from "../../src/scheduler/types.ts";

/** Counts graph lookups so the shared-cone bound is independent of timing. */
class CountingEdges extends WeakMap<Action, Set<Action>> {
  #reads = 0;

  /** Number of downstream adjacency lists requested. */
  get reads(): number {
    return this.#reads;
  }

  /** Returns a node's downstream edges and records the lookup. */
  override get(action: Action): Set<Action> | undefined {
    this.#reads++;
    return super.get(action);
  }
}

describe("hasInvalidUpstream()", () => {
  it("returns true for an invalid or never-run transitive writer", () => {
    const nodes = new NodeRegistry();
    const writer: Action = () => {};
    const middle: Action = () => {};
    const reader: Action = () => {};
    const dependents = new WeakMap<Action, Set<Action>>([
      [writer, new Set([middle])],
      [middle, new Set([reader])],
    ]);
    nodes.register(writer, "computation");
    expect(hasInvalidUpstream({ nodes, dependents }, reader)).toBe(true);
    nodes.setStatus(writer, "clean");
    expect(hasInvalidUpstream({ nodes, dependents }, reader)).toBe(false);
    nodes.setStatus(writer, "invalid");
    expect(hasInvalidUpstream({ nodes, dependents }, reader)).toBe(true);
  });

  it("excludes the reader itself even when it belongs to a cycle", () => {
    const nodes = new NodeRegistry();
    const reader: Action = () => {};
    const other: Action = () => {};
    const dependents = new WeakMap<Action, Set<Action>>([
      [reader, new Set([other])],
      [other, new Set([reader])],
    ]);
    nodes.register(reader, "computation");
    expect(hasInvalidUpstream({ nodes, dependents }, reader)).toBe(false);
    nodes.register(other, "computation");
    expect(hasInvalidUpstream({ nodes, dependents }, reader)).toBe(true);
  });

  it("visits a shared downstream cone at most once across invalid writers", () => {
    const nodes = new NodeRegistry();
    const dependents = new CountingEdges();
    const writers: Action[] = Array.from({ length: 64 }, () => () => {});
    const chain: Action[] = Array.from({ length: 64 }, () => () => {});
    const unreachable: Action = () => {};
    for (const writer of writers) {
      nodes.register(writer, "computation");
      dependents.set(writer, new Set([chain[0]]));
    }
    for (let i = 0; i < chain.length; i++) {
      dependents.set(chain[i], new Set([chain[(i + 1) % chain.length]]));
    }
    expect(hasInvalidUpstream({ nodes, dependents }, unreachable)).toBe(false);
    expect(dependents.reads).toBeLessThanOrEqual(writers.length + chain.length);
    dependents.get(chain.at(-1)!)!.add(unreachable);
    expect(hasInvalidUpstream({ nodes, dependents }, unreachable)).toBe(true);
  });
});
