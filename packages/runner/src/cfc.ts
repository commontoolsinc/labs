import { JSONSchemaObj } from "@commontools/api";
import { isObject, isRecord } from "@commontools/utils/types";
import { getLogger } from "@commontools/utils/logger";
import type { JSONSchema } from "./builder/types.ts";
import { CycleTracker } from "./traverse.ts";
import { isArrayIndexPropertyName } from "@commontools/memory/storable-value";
import { rendererVDOMSchema } from "@commontools/runner/schemas";

const logger = getLogger("cfc");

// I use these strings in other code, so make them available as
// constants. These are just strings, and real meaning would be
// up to implementation.
export const Classification = {
  Unclassified: "unclassified",
  Confidential: "confidential",
  Secret: "secret",
  TopSecret: "topsecret",
} as const;

// We'll often work with the transitive closure of this graph.
// I currently require this to be a DAG, but I could support cycles
// Technically, this is required to be a join-semilattice.
const classificationLattice = new Map<string, string[]>([
  [Classification.Unclassified, []],
  [Classification.Confidential, [Classification.Unclassified]],
  [Classification.Secret, [Classification.Confidential]],
  [Classification.TopSecret, [Classification.Secret]],
]);

// This class lets me sort with strongly connected components.
// These are not technically a partial order, since they violate antisymmetry.
// This uses an implementation of Tarjan's algorithm, which is O(V+E).
class _TarjanSCC {
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

  /**
   * Collect any required classification tags required by the schema.
   * This could be made more conservative by combining the schema with the object
   * If our object lacks any of the fields that would have a higher classification,
   * we don't need to consider them.
   *
   * @param joined set to which we will add any classification tags
   * @param schema the schema with tags
   * @param fullSchema the full schema with any $defs needed
   * @param cycleTracker used to avoid reference cycles
   */
  static joinSchema(
    joined: Set<string>,
    schema: JSONSchema,
    fullSchema: JSONSchema = schema,
    cycleTracker: CycleTracker<string> = new CycleTracker<string>(true),
  ): Set<string> {
    if (typeof schema === "boolean") {
      return joined;
    }
    // A resolved schema is often unique, since it's generated by combining
    // other schema. This means that we need to use the stringified form in
    // our cycle tracker, so we get proper equality checks.
    using t = cycleTracker.include(JSON.stringify(schema));
    if (t === null) {
      // we've already joined this
      return joined;
    }
    if (schema.ifc) {
      if (schema.ifc?.classification) {
        for (const classification of schema.ifc.classification) {
          joined.add(classification);
        }
      }
    }
    if (schema.properties && typeof schema.properties === "object") {
      for (const value of Object.values(schema.properties)) {
        ContextualFlowControl.joinSchema(
          joined,
          value,
          fullSchema,
          cycleTracker,
        );
      }
    }
    if (
      schema.additionalProperties &&
      typeof schema.additionalProperties === "object"
    ) {
      ContextualFlowControl.joinSchema(
        joined,
        schema.additionalProperties,
        fullSchema,
        cycleTracker,
      );
    } else if (schema.items && typeof schema.items === "object") {
      ContextualFlowControl.joinSchema(
        joined,
        schema.items,
        fullSchema,
        cycleTracker,
      );
    } else if (schema.$ref) {
      // Follow the references
      const resolvedSchema = ContextualFlowControl.resolveSchemaRefsOrThrow(
        schema,
        fullSchema,
      );
      ContextualFlowControl.joinSchema(
        joined,
        resolvedSchema,
        fullSchema,
        cycleTracker,
      );
    }
    return joined;
  }

  // Get the least upper bound classification from the schema.
  public lubSchema(
    schema: JSONSchema,
    extraClassifications?: Set<string>,
  ): string | undefined {
    const classifications = (extraClassifications !== undefined)
      ? new Set<string>(extraClassifications)
      : new Set<string>();
    ContextualFlowControl.joinSchema(classifications, schema);

    return (classifications.size === 0) ? undefined : this.lub(classifications);
  }

  public lub(joined: Set<string>): string {
    return ContextualFlowControl.findLub(this.lattice, joined);
  }

  // Return a copy of the schema with the least upper bound classifcation.
  public schemaWithLub(
    schema: JSONSchema,
    classification: string,
  ): JSONSchema {
    const joined = new Set<string>([classification]);
    if (isObject(schema) && schema.ifc !== undefined) {
      if (schema.ifc.classification !== undefined) {
        for (const item of schema.ifc.classification) {
          joined.add(item);
        }
      }
    }
    // If we have no classification, we can leave the schema
    if (joined.size === 0) {
      return schema;
    }
    // We don't really support "not" schemas, but it's the only good way we
    // have to attach ifc to a `false` schema.
    const schemaObj = ContextualFlowControl.toSchemaObj(schema);
    const restrictedSchema = {
      ...schemaObj,
      ifc: { classification: [this.lub(joined)] },
    };
    return restrictedSchema;
  }

  /**
   * Convert a schema that may be undefined or boolean to an object version.
   *
   * @param schema optional schema to convert
   */
  static toSchemaObj(schema?: JSONSchema): JSONSchemaObj {
    return (schema === true || schema === undefined)
      ? {}
      : schema === false
      ? { not: true }
      : schema;
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

  /**
   * Resolve a $ref in a schema, following other $ref links if needed.
   *
   * This doesn't currently handle $anchor tags or external documents
   * This will follow the $ref until the top level object is not a $ref.
   *
   * @param schemaObj an object containing the $ref, which may have properties
   *     that override those in the object pointed to by the $ref.
   * @param fullSchema Top level document for the schema which will be used
   *     to resolve the $ref. This should have the $defs.
   * @returns an updated JSONSchema, with a schema that points to the
   *     $ref's final target or undefined if the $ref could not be resolved.
   */
  static resolveSchemaRefs(
    schemaObj: JSONSchemaObj,
    fullSchema: JSONSchema = schemaObj,
  ): JSONSchema | undefined {
    // Track seen refs to avoid cycles
    const seenRefs = new Set<string>();
    while (true) {
      const { $ref, ...rest } = schemaObj;
      if ($ref === undefined) { // no more refs to resolve
        return schemaObj;
      } else if (seenRefs.has($ref)) {
        // Cycle -- equivalent to non-existent ref
        return undefined;
      }
      seenRefs.add($ref);
      const resolved = ContextualFlowControl.resolveSchemaRef(
        fullSchema,
        $ref,
      );
      if (resolved === undefined) { // Non-existent ref
        return undefined;
      }
      // If we have other properties, we need to keep them as we resolve refs.
      // They will override any properties in those refs.
      if (Object.keys(rest).length > 0) {
        if (isRecord(resolved)) {
          // Merge our attributes with those in the ref
          schemaObj = { ...resolved, ...rest } as JSONSchemaObj;
        } else {
          // Resolved to a boolean schema, so we can stop
          const schema = ContextualFlowControl.toSchemaObj(resolved);
          schemaObj = { ...schema, ...rest } as JSONSchemaObj;
        }
      } else if (typeof resolved === "boolean") {
        return resolved;
      } else {
        schemaObj = resolved;
      }
    }
  }

  // TODO(@ubik2): We may need to collect ifc labels as we walk the tree
  // This could be dome similarly to schemaAtPath, but that assumes
  // our cursor points at a schema, while we will walk objects like the
  // $defs that are not schema.
  // In the case where we point to a definition, this should already do
  // the right thing, since those are all at the top level. However, we
  // could have a reference to an anchor (not currently allowed), and
  // for those, if the User is secret, their Address should be too.
  /**
   * Resolve a $ref in a schema.
   * This doesn't currently handle $anchor tags or external documents
   *
   * If the schemaRef points to an object that is also a $ref, this will not
   * follow that link. Use resolveSchemaRefs for that behavior.
   *
   * @param fullSchema Top level document for the schema which will be used
   *     to resolve the $ref.
   * @param schemaRef the string value of the $ref
   * @returns an updated JSONSchema, with a schema that points to the
   *     $ref's target or undefined if the $ref could not be resolved.
   */
  static resolveSchemaRef(
    fullSchema: JSONSchema,
    schemaRef: string,
  ): JSONSchema | undefined {
    // Allow for some absolute schema refs
    if (schemaRef == "https://commontools.dev/schemas/vdom.json") {
      return rendererVDOMSchema;
    }
    // We only support schemaRefs that are URI fragments
    if (!schemaRef.startsWith("#")) {
      logger.warn("cfc", () => ["Unsupported $ref in schema: ", schemaRef]);
      return undefined;
    }
    // URI fragment schemaRefs are JSONPointers, so split and unescape
    const pathToDef = schemaRef.split("/").map((p) =>
      p.replace("~1", "/").replace("~0", "~")
    );
    // We don't support anchors yet (e.g. `"$ref": "#address"`)
    if (pathToDef[0] !== "#") {
      logger.warn(
        "cfc",
        () => ["Unsupported anchor $ref in schema: ", schemaRef],
      );
      return undefined;
    }
    let schemaCursor: unknown = fullSchema;
    // start at 1, since the 0 element is "#"
    for (let i = 1; i < pathToDef.length; i++) {
      if (!isRecord(schemaCursor) || !(pathToDef[i] in schemaCursor)) {
        logger.warn(
          "cfc",
          () => ["Unresolved $ref in schema: ", schemaRef, fullSchema],
        );
        return undefined;
      }
      schemaCursor = schemaCursor[pathToDef[i]];
    }
    // If our schema cursor is an object, carry the $defs in
    if (typeof schemaCursor === "object") {
      const schemaRefs = new Set<string>();
      this.findRefs(schemaCursor as JSONSchema, schemaRefs);
      // TODO(@ubik2): We could just carry in the $defs we need
      if (schemaRefs.size > 0) {
        schemaCursor = {
          ...schemaCursor,
          ...(isObject(fullSchema) && fullSchema.$defs &&
            { $defs: fullSchema.$defs }),
        };
      }
    }
    return schemaCursor as JSONSchema;
  }

  /**
   * Traverse a schema finding any $ref links.
   *
   * This does not scan the $defs, so a $ref that points to a $defs entry that
   * then references another $defs entry would not have that second reference
   * included.
   *
   * @param schema
   * @param refSet
   */
  static findRefs(
    schema: JSONSchema,
    refSet: Set<string> = new Set<string>(),
  ): void {
    if (typeof schema === "boolean") {
      return;
    }
    if (schema.$ref !== undefined) {
      refSet.add(schema.$ref);
    }
    if (schema.type === "array") {
      if (schema.items !== undefined) {
        ContextualFlowControl.findRefs(schema.items, refSet);
      }
      if (schema.prefixItems != undefined) {
        for (const item of schema.prefixItems) {
          ContextualFlowControl.findRefs(item, refSet);
        }
      }
    } else if (schema.type === "object") {
      if (schema.additionalProperties !== undefined) {
        ContextualFlowControl.findRefs(schema.additionalProperties, refSet);
      }
      if (schema.properties !== undefined) {
        for (const [_key, propSchema] of Object.entries(schema.properties)) {
          ContextualFlowControl.findRefs(propSchema, refSet);
        }
      }
    }
    const optSchemas = [
      ...(schema.anyOf ? schema.anyOf : []),
      ...(schema.oneOf ? schema.oneOf : []),
      ...(schema.allOf ? schema.allOf : []),
    ];
    for (const optSchema of optSchemas) {
      ContextualFlowControl.findRefs(optSchema, refSet);
    }
  }

  static resolveSchemaRefsOrThrow(
    schemaObj: JSONSchemaObj,
    fullSchema: JSONSchema = schemaObj,
  ) {
    if (!isObject(fullSchema)) {
      // We'd need a fullSchema to make this work
      // We don't need to do real cycle detection, since the path is limited
      throw new Error("Found $ref without fullSchema object");
    }
    const resolved = ContextualFlowControl.resolveSchemaRefs(
      schemaObj,
      fullSchema,
    );
    if (resolved === undefined) {
      throw new Error(`Failed to resolve $ref in ${JSON.stringify(schemaObj)}`);
    }
    return resolved;
  }

  // This is a variant of schemaAtPath that allows for an undefined schema.
  // It will return the empty object instead of true and undefined instead of false.
  getSchemaAtPath(
    schema: JSONSchema | undefined,
    path: string[],
    extraClassifications?: Set<string>,
  ): JSONSchema | undefined {
    if (schema === undefined) {
      return undefined;
    }
    const result = this.schemaAtPath(schema, path, extraClassifications);
    return result === false ? undefined : result === true ? {} : result;
  }

  /**
   * This gets the schema at a specific path.
   * This is a leaky abstraction, since you can have changes in a parent object
   * that shape the potential values and types of child objects.
   *
   * For example, if you have anyOf USAddress, CanadaAddress and the USAddress
   * differentiated by country name, when you ask for the postalCode, the schema
   * if the parent portions were a USAddress is a a sequence of 5 numbers.
   * However if the parent portions were a CanadaAddress, the postalCode is a
   * sequence of 6 letters or numbers.
   *
   * You can't know how the schema will be narrowed without evaluating it
   * against a candidate object.
   *
   * Nonetheless, it's very convenient to have a schema without knowing, so we
   * provide this method and use it.
   *
   * The additionalPropertiesDefault lets you change the behavior when there is
   * an object with an empty properties map and no additional properties.
   * The JSON-Schema spec would default this to true, but we often want to
   * use it to exclude properties that we don't care about without failing.
   * We also allow you to provide a special string value, so the caller can detect
   * that this has happened.
   *
   * While we will handle $ref links as needed while getting to the schema,
   * the returned object will retain those $ref links.
   */
  schemaAtPath(
    schema: JSONSchema,
    path: readonly string[],
    extraClassifications?: Set<string>,
    defaultEmptyProperties: JSONSchema = true,
    defaultMissingProperty: JSONSchema = true,
  ): JSONSchema {
    // Take defs from schema if available
    const defs = isObject(schema) && schema.$defs ? schema.$defs : undefined;
    return this.schemaAtPathInternal(
      schema,
      path,
      defs,
      extraClassifications,
      defaultEmptyProperties,
      defaultMissingProperty,
    );
  }

  private schemaAtPathInternal(
    schema: JSONSchema,
    path: readonly string[],
    defs: Record<string, JSONSchema> | undefined,
    extraClassifications: Set<string> | undefined,
    defaultEmptyProperties: JSONSchema,
    defaultMissingProperty: JSONSchema,
  ): JSONSchema {
    const joined = (extraClassifications !== undefined)
      ? new Set<string>(extraClassifications)
      : new Set<string>();
    let cursor = schema;
    for (
      const [index, part] of path.map((value, index) =>
        [index, value] as [number, string]
      )
    ) {
      // If the cursor is a $ref, get the target location
      if (isObject(cursor) && "$ref" in cursor) {
        // Follow the reference
        cursor = ContextualFlowControl.resolveSchemaRefsOrThrow(
          cursor,
          { $defs: defs },
        );
      }
      if (isObject(cursor) && ("anyOf" in cursor || "oneOf" in cursor)) {
        const subSchemas: JSONSchema[] = [];
        const subSchemaStrings: string[] = [];
        const options = (cursor.anyOf && cursor.oneOf)
          ? [...cursor.anyOf, ...cursor.oneOf]
          : cursor.anyOf ?? cursor.oneOf ?? [];
        for (const entry of options) {
          const optSchema = this.schemaAtPathInternal(
            entry,
            path.slice(index),
            defs,
            extraClassifications,
            defaultEmptyProperties,
            defaultMissingProperty,
          );
          if (typeof optSchema !== "boolean" && typeof optSchema !== "object") {
            return optSchema;
          }
          const subSchema = optSchema as JSONSchema | boolean;
          if (subSchema === false) {
            continue;
          } else if (ContextualFlowControl.isTrueSchema(subSchema)) {
            cursor = true;
            break;
          } else {
            const subSchemaString = JSON.stringify(subSchema);
            if (subSchemaStrings.includes(subSchemaString)) {
              continue;
            }
            subSchemas.push(subSchema as JSONSchema);
            subSchemaStrings.push(subSchemaString);
          }
        }
        if (subSchemas.length === 0) {
          cursor = false;
        } else if (subSchemas.length === 1) {
          cursor = subSchemas[0];
        } else {
          cursor = { "anyOf": subSchemas };
        }
        break;
      }
      if (typeof cursor === "boolean") {
        break;
      } else if (ContextualFlowControl.isTrueSchema(cursor)) {
        // wildcard schema -- equivalent to true, but we can add ifc tags
        break;
      } else if (cursor.type === "object") {
        if (cursor.ifc !== undefined && cursor.ifc.classification) {
          for (const classification of cursor.ifc.classification) {
            joined.add(classification);
          }
        }
        if (cursor.properties && part in cursor.properties) {
          const cursorObj = cursor.properties as Record<string, JSONSchema>;
          cursor = cursorObj[part];
          if (typeof cursor === "boolean") {
            break;
          } else {
            if (
              cursor.ifc !== undefined &&
              cursor.ifc.classification !== undefined
            ) {
              for (const classification of cursor.ifc.classification) {
                joined.add(classification);
              }
            }
          }
        } else if (cursor.additionalProperties !== undefined) {
          cursor = cursor.additionalProperties;
        } else if (
          cursor.properties && Object.keys(cursor.properties).length === 0
        ) {
          // We'll often ignore, but validate in this case
          cursor = defaultEmptyProperties;
        } else if (cursor.properties) {
          // We'll generally include these, but sometimes we don't
          cursor = defaultMissingProperty;
        } else { // no additionalProperties field is the same as having one that is true
          cursor = true;
        }
      } else if (cursor.type === "array") {
        if (isArrayIndexPropertyName(part)) {
          const index = Number(part);
          if (cursor.prefixItems && index < cursor.prefixItems.length) {
            cursor = cursor.prefixItems[index];
          } else {
            cursor = cursor.items ?? true;
          }
        } else {
          return false;
        }
      } else {
        // we can only descend into objects and arrays
        return false;
      }
    }
    if (
      isObject(cursor) && cursor.ifc !== undefined &&
      cursor.ifc?.classification !== undefined
    ) {
      for (const classification of cursor.ifc.classification!) {
        joined.add(classification);
      }
    }
    if (typeof cursor === "boolean") {
      if (!cursor) {
        return false; // no need to attach tags -- we'll never match
      } else if (joined.size === 0) {
        return true; // no ifc tags -- can just return true
      }
      cursor = {}; // change to use the empty object schema, so we can attach ifc.
    }
    // If we've encountered any classification tags while walking down the schema, we need to add them to the returned object
    const ifc = (joined.size !== 0)
      ? { ...cursor.ifc, classification: [this.lub(joined)] }
      : cursor.ifc;
    // Merge any ifc and defs
    return { ...cursor, ...(ifc && { ifc }), ...(defs && { $defs: defs }) };
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
    for (const [from, _tos] of graph.entries()) {
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

  // Check to see if the specified schema is one of the special values meaning
  // it should always validate.
  static isTrueSchema(schema: JSONSchema): boolean {
    if (schema === true) {
      return true;
    }
    return isObject(schema) &&
      Object.keys(schema).every((k) =>
        this.isInternalSchemaKey(k) || k === "default" || k === "$defs"
      );
  }

  // We don't need to check ID and ID_FIELD, since they won't be included
  // in Object.keys return values.
  static isInternalSchemaKey(key: string): boolean {
    return key === "ifc" || key === "asCell" || key === "asStream" ||
      key === "asOpaque";
  }

  static isFalseSchema(schema: JSONSchema): boolean {
    return schema === false || (isObject(schema) && schema["not"] === true);
  }
}
