// This is a simple form of the policy, where you express the basics of the partial ordering.

import type { JSONSchema, JSONValue } from "@commontools/builder";
import { isObject } from "@commontools/utils/types";
import { extractDefaultValues } from "./utils.ts";

// We'll often work with the transitive closure of this graph.
// I currently require this to be a DAG, but I could support cycles
// Technically, this is required to be a join-semilattice.
const classificationLattice = new Map<string, string[]>([
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

// Class for handling cfc rules.
// Right now, we just drop this constructor all over, but eventually
// we'll get our lattice from the user, so we should be constructing
// these objects where we have access to the user's preferences.
// These preferences are likely per user/space combination.
export class ContextualFlowControl {
  private reachable: Map<string, Set<string>>;
  constructor(
    private lattice: Map<string, string[]> = classificationLattice,
  ) {
    this.reachable = ContextualFlowControl.reachableNodes(lattice);
  }

  // This could be made more conservative by combining the schema with the object
  // If our object lacks any of the fields that would have a higher classification,
  // we don't need to consider them.
  public joinSchema(
    joined: Set<string>,
    schema: JSONSchema,
    rootSchema?: JSONSchema,
  ) {
    if (schema.ifc) {
      if (schema.ifc?.classification) {
        console.log(
          "Found item with classification",
          schema.ifc.classification,
        );
        for (const classification of schema.ifc.classification) {
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

  // Get the least upper bound classification from the schema.
  public lubSchema(
    schema: JSONSchema,
    rootSchema?: JSONSchema,
    extraClassifications?: Set<string>,
  ) {
    const classifications = (extraClassifications !== undefined)
      ? new Set<string>(extraClassifications)
      : new Set<string>();
    return this.joinSchema(classifications, schema, rootSchema);
  }

  public lub(joined: Set<string>) {
    return ContextualFlowControl.findLub(this.lattice, joined);
  }

  // Return a copy of the schema with the least upper bound classifcation.
  public schemaWithLub<T>(schema: JSONSchema, classification: string) {
    const joined = new Set<string>([classification]);
    if (schema.ifc !== undefined) {
      if (schema.ifc.classification !== undefined) {
        for (const item of schema.ifc.classification) {
          joined.add(item);
        }
      }
    }
    const restrictedSchema = {
      ...schema,
      ifc: { classification: [this.lub(joined)] },
    };
    return restrictedSchema;
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

  // Return the Least Upper Bound for the set of classification values
  // This could be almost certainly be more efficient.
  static findLub<T>(graph: Map<T, T[]>, joined: Set<T>): T {
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
      if (reachableFrom.isSupersetOf(joined)) {
        return from;
      }
      reachable.set(from, reachableFrom);
    }
    throw Error("Improper lattice");
  }

  schemaAtPath(
    schema: JSONSchema | boolean,
    path: string[],
    extraClassifications?: Set<string>,
  ): JSONSchema | boolean | undefined {
    const joined = (extraClassifications !== undefined)
      ? new Set<string>(extraClassifications)
      : new Set<string>();
    let cursor = schema;
    for (const part of path) {
      if (typeof cursor === "boolean") {
        break;
      } else if ("$ref" in cursor) {
        // We'd need a rootSchema to make this work
        // We don't need to do real cycle detection, since the path is limited
        throw new Error("schemaAtPath doesn't yet support following $ref");
      } else if (isObject(cursor) && Object.keys(cursor).length == 0) {
        // wildcard schema -- equivalent to true, but we can add ifc tags
        break;
      } else if (cursor.type === "object") {
        if (cursor.ifc !== undefined && cursor.ifc.classification) {
          for (const classification of cursor.ifc.classification) {
            joined.add(classification);
          }
        }
        if (cursor.properties && part in cursor.properties) {
          const cursorObj = cursor.properties as Record<
            string,
            JSONSchema | boolean
          >;
          cursor = cursorObj[part];
          if (typeof cursor === "boolean") {
            break;
          } else {
            const schemaCursor = cursor as JSONSchema;
            if (
              schemaCursor.ifc !== undefined &&
              schemaCursor.ifc?.classification !== undefined
            ) {
              for (const classification of schemaCursor.ifc.classification) {
                joined.add(classification);
              }
            }
          }
        } else if (cursor.additionalProperties) {
          cursor = cursor.additionalProperties;
        } else {
          return false;
        }
      } else if (cursor.type === "array" && cursor.items) {
        const numericKeyValue = new Number(part).valueOf();
        if (Number.isInteger(numericKeyValue) && numericKeyValue >= 0) {
          cursor = cursor.items;
        } else {
          return false;
        }
      } else {
        // we can only descend into objects and arrays
        return false;
      }
    }
    if (
      typeof cursor === "object" && (cursor as JSONSchema).ifc !== undefined &&
      (cursor as JSONSchema).ifc?.classification !== undefined
    ) {
      for (const classification of cursor.ifc!.classification!) {
        joined.add(classification);
      }
    }
    if (joined.size === 0) {
      return cursor; // no need for classification tags
    }
    if (typeof cursor === "boolean") {
      if (!cursor) {
        return false; // no need to attach tags -- we'll never match
      }
      cursor = {}; // change to use the empty object schema, so we can attach ifc.
    }
    // If we've encountered any classification tags while walking down the schema, we need to add them to the returned object
    const existingIfc = cursor.ifc ? cursor.ifc : {};
    const ifc = {
      ...existingIfc,
      classification: [this.lub(joined)],
    };
    return { ...cursor, ifc: ifc };
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
