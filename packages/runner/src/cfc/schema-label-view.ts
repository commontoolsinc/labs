import type { JSONSchema } from "@commonfabric/api";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { ContextualFlowControl } from "../cfc.ts";
import { forEachSubschema, isSubschema } from "../schema-walk.ts";
import { cfcSchemaChildRoot, resolveCfcSchemaRefRoot } from "./schema-refs.ts";
import { type CfcLabelView, mergeCfcLabelViews } from "./label-view-state.ts";
import type { IFCLabel, LabelObservationClass } from "./types.ts";

/** One `ifc` declaration found while walking a CFC schema. */
export interface CfcSchemaEntry {
  readonly path: readonly string[];
  readonly label: IFCLabel;
  readonly schema: JSONSchema;
  /** The schema document that resolves local references inside `.schema`. */
  readonly root: JSONSchema;
  /** Enclosing anyOf and oneOf branches that must match this declaration. */
  readonly branchConditions: readonly CfcSchemaBranchCondition[];
}

export interface CfcSchemaBranchCondition {
  readonly path: readonly string[];
  readonly schema: JSONSchema;
  /** The enclosing schema narrows positive evidence but not restrictions. */
  readonly enclosing?: true;
  /** The schema document that resolves local references inside `.schema`. */
  readonly root: JSONSchema;
}

interface IfcSchemaVisit {
  root: object;
  schema: object;
  ref?: string;
  refRoot?: object;
  parent?: IfcSchemaVisit;
}

const schemaStructureContainsIfc = (
  schema: JSONSchema,
  seen = new WeakSet<object>(),
): boolean => {
  if (!isSubschema(schema) || typeof schema === "boolean") return false;
  if (seen.has(schema)) return false;
  seen.add(schema);
  if (isObjectOrArray(schema.ifc)) {
    return true;
  }
  return forEachSubschema(
    schema,
    (child) => schemaStructureContainsIfc(child, seen),
    { includeDefs: true, includeUnused: true },
  );
};

const schemaSubtreeContainsIfc = (
  schema: JSONSchema,
  root: JSONSchema,
  seen = new WeakMap<object, WeakSet<object>>(),
  activeRefs = new WeakMap<object, Set<string>>(),
): boolean => {
  if (!isSubschema(schema) || typeof schema === "boolean") return false;
  const schemaRoot = cfcSchemaChildRoot(schema, root);
  const unresolvedRoot = isObjectOrArray(schemaRoot) ? schemaRoot : schema;
  let activeForRoot: Set<string> | undefined;
  let resolved: JSONSchema = schema;
  if (typeof schema.$ref === "string") {
    activeForRoot = activeRefs.get(unresolvedRoot);
    if (activeForRoot?.has(schema.$ref)) return false;
    if (!activeForRoot) {
      activeForRoot = new Set();
      activeRefs.set(unresolvedRoot, activeForRoot);
    }
    activeForRoot.add(schema.$ref);
    try {
      resolved = ContextualFlowControl.resolveSchemaRefs(schema, schemaRoot) ??
        schema;
    } catch {
      activeForRoot.delete(schema.$ref);
      return schemaStructureContainsIfc(schema);
    }
  }
  if (typeof resolved === "boolean") {
    if (typeof schema.$ref === "string") activeForRoot?.delete(schema.$ref);
    return false;
  }
  const childRoot = cfcSchemaChildRoot(
    resolved,
    typeof schema.$ref === "string"
      ? resolveCfcSchemaRefRoot(schema, schemaRoot)
      : schemaRoot,
  );
  const rootKey = isObjectOrArray(childRoot) ? childRoot : resolved;
  let seenForRoot = seen.get(rootKey);
  if (seenForRoot?.has(resolved)) {
    if (typeof schema.$ref === "string") activeForRoot?.delete(schema.$ref);
    return false;
  }
  if (!seenForRoot) {
    seenForRoot = new WeakSet();
    seen.set(rootKey, seenForRoot);
  }
  seenForRoot.add(resolved);
  const containsIfc = isObjectOrArray(resolved.ifc) || forEachSubschema(
    resolved,
    (child) => schemaSubtreeContainsIfc(child, childRoot, seen, activeRefs),
    { includeUnused: true },
  );
  if (typeof schema.$ref === "string") activeForRoot?.delete(schema.$ref);
  return containsIfc;
};

const schemaPlacementPath = (
  path: string,
  keyword: string,
  key: string | undefined,
  index: number | undefined,
): string =>
  `${path}.${keyword}${key === undefined ? "" : `.${key}`}${
    index === undefined ? "" : `[${index}]`
  }`;

/**
 * Reject IFC placements whose value path or branch meaning cannot be
 * represented by the persisted label map.
 */
export const cfcPolicyPlacementIssue = (
  schema: JSONSchema,
): string | undefined => {
  const walk = (
    current: JSONSchema,
    root: JSONSchema,
    path: string,
    active?: IfcSchemaVisit,
  ): string | undefined => {
    if (!isSubschema(current) || typeof current === "boolean") return undefined;
    const schemaRoot = cfcSchemaChildRoot(current, root);
    const unresolvedRootKey = isObjectOrArray(schemaRoot)
      ? schemaRoot
      : current;
    if (typeof current.$ref === "string") {
      for (let cursor = active; cursor !== undefined; cursor = cursor.parent) {
        if (
          cursor.ref === current.$ref && cursor.refRoot === unresolvedRootKey
        ) {
          return schemaSubtreeContainsIfc(current, schemaRoot)
            ? `${path}: recursive IFC policy cannot be represented by label paths`
            : undefined;
        }
      }
    }
    let resolved: JSONSchema = current;
    if (typeof current.$ref === "string") {
      try {
        resolved = ContextualFlowControl.resolveSchemaRefs(
          current,
          schemaRoot,
        ) ?? current;
      } catch {
        return schemaStructureContainsIfc(current)
          ? `${path}: recursive IFC policy cannot be represented by label paths`
          : undefined;
      }
    }
    if (typeof resolved === "boolean") return undefined;
    const childRoot = cfcSchemaChildRoot(
      resolved,
      typeof current.$ref === "string"
        ? resolveCfcSchemaRefRoot(current, schemaRoot)
        : schemaRoot,
    );
    const rootKey = isObjectOrArray(childRoot) ? childRoot : resolved;
    for (let cursor = active; cursor !== undefined; cursor = cursor.parent) {
      if (cursor.root !== rootKey || cursor.schema !== resolved) continue;
      return schemaSubtreeContainsIfc(resolved, childRoot)
        ? `${path}: recursive IFC policy cannot be represented by label paths`
        : undefined;
    }
    const nextActive = {
      root: rootKey,
      schema: resolved,
      ...(typeof current.$ref === "string"
        ? { ref: current.$ref, refRoot: unresolvedRootKey }
        : {}),
      parent: active,
    };
    let issue: string | undefined;
    const namedProperties = isObjectOrArray(resolved.properties) &&
      Object.keys(resolved.properties).length > 0;
    const unsupported = new Set([
      "if",
      "then",
      "else",
      "contains",
      "propertyNames",
      "contentSchema",
      "patternProperties",
      "dependentSchemas",
      "not",
    ]);
    forEachSubschema(
      resolved,
      (child, keyword, key, index) => {
        const childPath = schemaPlacementPath(path, keyword, key, index);
        if (
          (unsupported.has(keyword) ||
            keyword === "additionalProperties" && namedProperties) &&
          schemaSubtreeContainsIfc(child, childRoot)
        ) {
          issue = `${childPath}: IFC policy under ${keyword} is unsupported`;
          return true;
        }
        issue = walk(child, childRoot, childPath, nextActive);
        return issue !== undefined;
      },
      { includeUnused: true },
    );
    return issue;
  };
  return walk(schema, schema, "$");
};

/**
 * Return every `ifc` declaration in a schema at its logical value path.
 *
 * Compound schemas contribute at their current path. Array items and
 * record-only additional properties use a wildcard path. Tuple entries use
 * their concrete index. Negated schemas do not describe labels on real data.
 */
export const cfcSchemaEntries = (
  schema: JSONSchema,
  path: readonly string[] = [],
  entries: CfcSchemaEntry[] = [],
  root: JSONSchema = schema,
  active?: IfcSchemaVisit,
  branchConditions: readonly CfcSchemaBranchCondition[] = [],
): CfcSchemaEntry[] => {
  if (!isSubschema(schema) || typeof schema === "boolean") {
    return entries;
  }
  const schemaRoot = cfcSchemaChildRoot(schema, root);
  const rootKey = isObjectOrArray(schemaRoot) ? schemaRoot : schema;
  for (let cursor = active; cursor !== undefined; cursor = cursor.parent) {
    if (cursor.root === rootKey && cursor.schema === schema) return entries;
  }
  const nextActive = { root: rootKey, schema, parent: active };

  const resolved = typeof schema.$ref === "string"
    ? ContextualFlowControl.resolveSchemaRefs(schema, schemaRoot) ?? schema
    : schema;
  if (typeof resolved === "boolean") {
    return entries;
  }

  const childRoot = cfcSchemaChildRoot(
    resolved,
    typeof schema.$ref === "string"
      ? resolveCfcSchemaRefRoot(schema, schemaRoot)
      : schemaRoot,
  );
  if (isObjectOrArray(resolved.ifc)) {
    entries.push({
      path,
      label: {
        integrity: Array.isArray(resolved.ifc.integrity)
          ? [...resolved.ifc.integrity]
          : undefined,
        confidentiality: Array.isArray(resolved.ifc.confidentiality)
          ? [...resolved.ifc.confidentiality]
          : undefined,
      },
      schema: resolved,
      root: childRoot,
      branchConditions,
    });
  }

  const recordOnly = resolved.properties === undefined ||
    (isObjectOrArray(resolved.properties) &&
      Object.keys(resolved.properties).length === 0);
  forEachSubschema(resolved, (child, keyword, key, index) => {
    switch (keyword) {
      case "properties":
        cfcSchemaEntries(
          child,
          [...path, key!],
          entries,
          childRoot,
          nextActive,
          branchConditions,
        );
        break;
      case "anyOf":
      case "oneOf":
        cfcSchemaEntries(child, path, entries, childRoot, nextActive, [
          ...branchConditions,
          {
            path,
            schema: resolved,
            root: childRoot,
            enclosing: true,
          },
          {
            path,
            schema: child,
            root: cfcSchemaChildRoot(child, childRoot),
          },
        ]);
        break;
      case "allOf":
        cfcSchemaEntries(
          child,
          path,
          entries,
          childRoot,
          nextActive,
          [
            ...branchConditions,
            {
              path,
              schema: resolved,
              root: childRoot,
              enclosing: true,
            },
          ],
        );
        break;
      case "items":
        // The wildcard covers tuple positions and the rest schema when
        // `.prefixItems` is present.
        cfcSchemaEntries(
          child,
          [...path, "*"],
          entries,
          childRoot,
          nextActive,
          branchConditions,
        );
        break;
      case "prefixItems":
        cfcSchemaEntries(
          child,
          [...path, String(index!)],
          entries,
          childRoot,
          nextActive,
          branchConditions,
        );
        break;
      case "additionalProperties":
        // A wildcard cannot express "all properties except the named ones".
        // It is exact only when the schema declares no named properties.
        if (recordOnly) {
          cfcSchemaEntries(
            child,
            [...path, "*"],
            entries,
            childRoot,
            nextActive,
            branchConditions,
          );
        }
        break;
      case "not":
        // A negated schema does not describe declarations on real data.
        break;
      default:
        // Unknown structural keywords contribute at the current position.
        cfcSchemaEntries(
          child,
          path,
          entries,
          childRoot,
          nextActive,
          branchConditions,
        );
        break;
    }
  });
  return entries;
};

const declaredObservationClass = (
  schema: JSONSchema,
): LabelObservationClass | undefined => {
  const observes = isObjectOrArray(schema) && isObjectOrArray(schema.ifc)
    ? schema.ifc.observes
    : undefined;
  return observes === "value" || observes === "shape" ||
      observes === "enumerate" || observes === "followRef"
    ? observes
    : undefined;
};

/** Return the label view declared by a schema. */
export const cfcLabelViewFromSchema = (
  schema: JSONSchema | undefined,
): CfcLabelView | undefined => {
  if (schema === undefined) return undefined;
  const entries = cfcSchemaEntries(schema).map((entry) => {
    const observes = declaredObservationClass(entry.schema);
    return {
      path: entry.path,
      label: entry.label,
      ...(observes === undefined ? {} : { observes }),
    };
  });
  return mergeCfcLabelViews([
    entries.length === 0 ? undefined : { version: 1, entries },
  ]);
};
