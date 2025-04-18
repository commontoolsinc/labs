// This is a simple form of the policy, where you express the basics of the partial ordering.

import { type JSONSchema } from "@commontools/builder";

// We'll work with the transitive closure of this graph.
const defaultClassificationPolicy = new Map<string, string[]>([
  ["unclassified", []],
  ["confidential", ["unclassified"]],
  ["secret", ["confidential"]],
  ["topsecret", ["secret"]],
]);

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
    } else if (schema.$ifc) {
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
    const sortedNodeIndices = ContextualFlowControl.topologicalSort(
      nodeCount,
      edges,
    );
    // We haven't changed the graph, so the index in the entries matches the nodeId used
    const entries = Array.from(graph.entries());
    return sortedNodeIndices.map((index) => entries[index]);
  }

  // Based on the edges, returns the indexes of the nodes in topological order.
  // The result is sorted so the node's children are after it in the list
  // This is a Kahn's algorithm implementation.
  // It assumes the graph is a DAG (Directed Acyclic Graph).
  // We implement topological sort in other places, but this is a simpler version
  private static topologicalSort(
    nodeCount: number,
    edges: [number, number][],
  ): number[] {
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

    return result;
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
