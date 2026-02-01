/**
 * TrustLattice encodes the hardcoded relationships between atom kinds,
 * including the classification hierarchy and composite label comparison.
 */

import { type Atom, atomEquals, canonicalizeAtom } from "./atoms.ts";
import { type Label } from "./labels.ts";
import { confidentialityLeq } from "./confidentiality.ts";
import { integrityLeq } from "./integrity.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LatticeRelation = "above" | "below" | "equal" | "incomparable";

// ---------------------------------------------------------------------------
// Default classification order
// ---------------------------------------------------------------------------

const DEFAULT_CLASSIFICATION_ORDER: Map<string, string[]> = new Map([
  ["unclassified", []],
  ["confidential", ["unclassified"]],
  ["secret", ["confidential"]],
  ["topsecret", ["secret"]],
]);

// ---------------------------------------------------------------------------
// Graph Algorithms - Tarjan SCC and Kahn Topological Sort
// ---------------------------------------------------------------------------

/**
 * Tarjan's Strongly Connected Components algorithm.
 * Groups nodes such that there's a path from every node to every other node
 * within the same group. This is used for identifying cycles in directed graphs.
 * Time complexity: O(V+E)
 *
 * Groups are ordered such that if we have an edge [0,1], we get [[0], [1]]
 */
export class TarjanSCC {
  private index: number = 0;
  private vertexIndices: number[];
  private vertexLowLink: number[];
  private vertexOnStack: boolean[];
  private stack: number[] = [];
  private adjacency: number[][];
  private sorted: number[][];

  constructor(nodeCount: number, edges: [number, number][]) {
    // Build an array with each item having the list of nodes that point to it.
    this.adjacency = Array.from({ length: nodeCount }, () => []);
    for (const [from, to] of edges) {
      this.adjacency[from].push(to);
    }
    this.sorted = [];
    this.vertexIndices = new Array(nodeCount);
    this.vertexLowLink = new Array(nodeCount);
    this.vertexOnStack = new Array(nodeCount);
    for (let v = 0; v < nodeCount; v++) {
      if (this.vertexIndices[v] === undefined) {
        this.strongConnect(v);
      }
    }
    this.sorted.reverse();
  }

  get result() {
    return this.sorted;
  }

  private strongConnect(v: number) {
    this.vertexIndices[v] = this.index;
    this.vertexLowLink[v] = this.index;
    this.index = this.index + 1;
    this.stack.push(v);
    this.vertexOnStack[v] = true;

    for (const w of this.adjacency[v]) {
      if (this.vertexIndices[w] === undefined) {
        // vertex w not yet visited
        this.strongConnect(w);
        this.vertexLowLink[v] = this.vertexLowLink[v] < this.vertexLowLink[w]
          ? this.vertexLowLink[v]
          : this.vertexLowLink[w];
      } else if (this.vertexOnStack[w]) {
        // vertex w is on the stack, so it's in our SCC
        this.vertexLowLink[v] = this.vertexLowLink[v] < this.vertexLowLink[w]
          ? this.vertexLowLink[v]
          : this.vertexLowLink[w];
      }
    }

    if (this.vertexLowLink[v] === this.vertexIndices[v]) {
      // this is a new SCC
      let w;
      const scc = [];
      do {
        w = this.stack.pop()!;
        this.vertexOnStack[w] = false;
        scc.push(w);
      } while (w != v);
      this.sorted.push(scc);
    }
  }
}

/**
 * Kahn's topological sort algorithm.
 * Returns the indexes of the nodes in topological order.
 * The result is sorted so that a node's children appear after it in the list.
 * Time complexity: O(V+E)
 *
 * Assumes the graph is a DAG (Directed Acyclic Graph).
 * Items are ordered such that if we have an edge [0,1], we get [0, 1]
 */
export class KahnTopologicalSort {
  private sorted: number[];

  constructor(nodeCount: number, edges: [number, number][]) {
    // Build an array with each item having the list of nodes that point to it.
    const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);
    for (const [from, to] of edges) {
      adjacency[from].push(to);
    }

    const indegree = Array(nodeCount).fill(0); // count of incoming edges
    for (let i = 0; i < nodeCount; i++) {
      for (const j of adjacency[i]) {
        indegree[j]++;
      }
    }

    const queue: number[] = [];
    for (let i = 0; i < nodeCount; i++) {
      if (indegree[i] === 0) queue.push(i);
    }

    const result = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      result.push(node);

      for (const neighbor of adjacency[node!]) {
        indegree[neighbor]--;
        if (indegree[neighbor] === 0) {
          queue.push(neighbor);
        }
      }
    }

    if (result.length !== nodeCount) {
      throw new Error("Graph is not a DAG (cycle detected)");
    }

    this.sorted = result;
  }

  get result() {
    return this.sorted;
  }
}

// ---------------------------------------------------------------------------
// TrustLattice
// ---------------------------------------------------------------------------

export class TrustLattice {
  private readonly order: Map<string, string[]>;
  private readonly reachableCache: Map<string, Set<string>>;

  constructor(classificationOrder?: Map<string, string[]>) {
    this.order = classificationOrder ?? DEFAULT_CLASSIFICATION_ORDER;
    this.reachableCache = new Map();

    // Pre-compute reachability for all levels.
    for (const level of this.order.keys()) {
      this.reachableCache.set(level, this.computeReachable(level));
    }
  }

  /** All levels transitively below the given level (not including itself). */
  reachable(level: string): Set<string> {
    const cached = this.reachableCache.get(level);
    if (cached) return cached;
    // For levels not in the order map, return empty.
    const computed = this.computeReachable(level);
    this.reachableCache.set(level, computed);
    return computed;
  }

  /** Is classification level a <= b? */
  classificationLeq(a: string, b: string): boolean {
    if (a === b) return true;
    return this.reachable(b).has(a);
  }

  /** Compare two individual atoms. */
  compareAtoms(a: Atom, b: Atom): LatticeRelation {
    if (atomEquals(a, b)) return "equal";

    // Classification atoms use the classification order.
    if (a.kind === "Classification" && b.kind === "Classification") {
      const aLevel = a.level;
      const bLevel = b.level;
      const aReachesB = this.reachable(aLevel).has(bLevel);
      const bReachesA = this.reachable(bLevel).has(aLevel);
      if (aReachesB) return "above";
      if (bReachesA) return "below";
      return "incomparable";
    }

    // Different kinds or same kind with different parameters.
    return "incomparable";
  }

  /** Compare composite labels. */
  compareLabels(a: Label, b: Label): LatticeRelation {
    const aLeqB =
      confidentialityLeq(a.confidentiality, b.confidentiality) &&
      integrityLeq(a.integrity, b.integrity);
    const bLeqA =
      confidentialityLeq(b.confidentiality, a.confidentiality) &&
      integrityLeq(b.integrity, a.integrity);

    if (aLeqB && bLeqA) return "equal";
    if (aLeqB) return "below";
    if (bLeqA) return "above";
    return "incomparable";
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private computeReachable(level: string): Set<string> {
    const visited = new Set<string>();
    const queue: string[] = [];

    const directChildren = this.order.get(level);
    if (directChildren) {
      for (const child of directChildren) {
        queue.push(child);
      }
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const children = this.order.get(current);
      if (children) {
        for (const child of children) {
          if (!visited.has(child)) {
            queue.push(child);
          }
        }
      }
    }

    return visited;
  }
}
