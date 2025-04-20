// This is a simple form of the policy, where you express the basics of the partial ordering.

import { type JSONSchema } from "@commontools/builder";

// We'll work with the transitive closure of this graph.
// I currently require this to be a DAG, but I could support cycles
const defaultClassificationPolicy = new Map<string, string[]>([
  ["unclassified", []],
  ["confidential", ["unclassified"]],
  ["secret", ["confidential"]],
  ["topsecret", ["secret"]],
]);

// This class lets me sort with strongly connected components.
// These are not technically a partial order, since they violate antisymmetry.
// This uses an implementation of Tarjan's algorithm, which is O(V+E).
class TarjanSCC {
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

  // Groups are ordered such that if we have an edge [0,1], we get [[0], [1]]
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

// Based on the edges, returns the indexes of the nodes in topological order.
// The result is sorted so the node's children are after it in the list
// This uses an implementation of Kahn's algorithm, which is O(V+E).
// It assumes the graph is a DAG (Directed Acyclic Graph)
// We implement topological sort in other places, but this is a simpler version
class KahnTopologicalSort {
  private sorted: number[];
  constructor(nodeCount: number, edges: [number, number][]) {
    // Build an array with each item having the list of nodes that poitnt to it.
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

  // Items are ordered such that if we have an edge [0,1], we get [0, 1]
  get result() {
    return this.sorted;
  }
}

export class ContextualFlowControl {
  private reachable: Map<string, Set<string>>;
  constructor(
    private policy: Map<string, string[]> = defaultClassificationPolicy,
  ) {
    this.reachable = ContextualFlowControl.reachableNodes(policy);
  }

  // This could be made more conservative by combining the schema with the object
  // If our object lacks any of the fields that would have a higher classification,
  // we don't need to consider them.
  public joinSchema(
    joined: Set<string>,
    schema: JSONSchema,
    rootSchema?: JSONSchema,
  ) {
    if (schema.$ifc) {
      if (schema.$ifc?.classification) {
        console.log(
          "Found item with classification",
          schema.$ifc.classification,
        );
        for (const classification of schema.$ifc.classification) {
          for (const reachable of this.reachable.get(classification)!) {
            joined.add(reachable);
          }
        }
      }
    }
    if (schema.properties && typeof schema.properties === "object") {
      for (const value of Object.values(schema.properties)) {
        this.joinSchema(joined, value, rootSchema);
      }
    }
    if (
      schema.additionalProperties &&
      typeof schema.additionalProperties === "object"
    ) {
      this.joinSchema(joined, schema.additionalProperties, rootSchema);
    } else if (schema.items && typeof schema.items === "object") {
      this.joinSchema(joined, schema.items, rootSchema);
    } else if (schema.$ref) {
      console.log("Error: $ref not supported yet");
    }
    return joined;
  }

  // Compute the transitive closure, which is the set of all nodes reachable from each node.
  // May want to consider Warshall algorithm for this.
  static reachableNodes<T>(graph: Map<T, T[]>): Map<T, Set<T>> {
    const sortedNodes = ContextualFlowControl.sortedGraphNodes(graph);
    const reachable = new Map<T, Set<T>>();
    for (const [from, tos] of sortedNodes.reverse()) {
      const reachableFrom = new Set<T>();
      for (const to of tos) {
        // Add the elements in tos to reachableFrom
        for (const tutu of reachable.get(to)!) {
          reachableFrom.add(tutu);
        }
        reachableFrom.add(to);
      }
      reachableFrom.add(from);
      reachable.set(from, reachableFrom);
    }
    return reachable;
  }

  private static sortedGraphNodes<T>(graph: Map<T, T[]>) {
    const [nodeCount, edges] = ContextualFlowControl.graphToEdges(graph);
    const sortHelper = new KahnTopologicalSort(nodeCount, edges);
    // We haven't changed the graph, so the index in the entries matches the nodeId used
    const entries = Array.from(graph.entries());
    return sortHelper.result.map((index) => entries[index]);
  }

  private static graphToEdges<T>(
    graph: Map<T, T[]>,
  ): [number, [number, number][]] {
    const nodeIds: Map<T, number> = new Map();
    let nodeCount = 0;
    // First, assign each key an id
    for (const [from, tos] of graph.entries()) {
      nodeIds.set(from, nodeCount++);
    }
    // Second pass to build the edges, now that we have ids
    const edges: [number, number][] = [];
    for (const [from, tos] of graph.entries()) {
      const fromIndex = nodeIds.get(from);
      for (const to of tos) {
        edges.push([fromIndex!, nodeIds.get(to)!]);
      }
    }
    return [nodeCount, edges];
  }
}
