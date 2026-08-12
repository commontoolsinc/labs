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
}

interface IfcSchemaVisit {
  root: object;
  schema: object;
  parent?: IfcSchemaVisit;
}

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
  if (resolved.ifc !== undefined) {
    entries.push({
      path,
      label: {
        integrity: resolved.ifc.integrity
          ? [...resolved.ifc.integrity]
          : undefined,
        confidentiality: resolved.ifc.confidentiality
          ? [...resolved.ifc.confidentiality]
          : undefined,
      },
      schema: resolved,
      root: childRoot,
    });
  }

  const recordOnly = resolved.properties === undefined ||
    Object.keys(resolved.properties).length === 0;
  forEachSubschema(resolved, (child, keyword, key, index) => {
    switch (keyword) {
      case "properties":
        cfcSchemaEntries(
          child,
          [...path, key!],
          entries,
          childRoot,
          nextActive,
        );
        break;
      case "anyOf":
      case "oneOf":
      case "allOf":
        cfcSchemaEntries(child, path, entries, childRoot, nextActive);
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
        );
        break;
      case "prefixItems":
        cfcSchemaEntries(
          child,
          [...path, String(index!)],
          entries,
          childRoot,
          nextActive,
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
          );
        }
        break;
      case "not":
        // A negated schema does not describe declarations on real data.
        break;
      default:
        // Unknown structural keywords contribute at the current position.
        cfcSchemaEntries(child, path, entries, childRoot, nextActive);
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
