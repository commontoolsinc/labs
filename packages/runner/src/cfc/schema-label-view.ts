import type { JSONSchema } from "@commonfabric/api";
import { isDeepFrozen } from "@commonfabric/data-model";
import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  forEachSubschema,
  isSubschema,
} from "@commonfabric/data-model-schema/schema-walk";
import { ContextualFlowControl } from "../cfc.ts";
import {
  externalResolutionMissCount,
  onSchemaRegistryClear,
} from "../schema-registry.ts";
import {
  cfcSchemaResolvedRoot,
  resolveCfcSchemaRefRoot,
} from "./schema-refs.ts";
import { type CfcLabelView, mergeCfcLabelViews } from "./label-view-state.ts";
import type { IFCLabel, LabelObservationClass } from "./types.ts";

/** One `ifc` declaration found while walking a CFC schema. */
export interface CfcSchemaEntry {
  readonly path: readonly string[];
  readonly label: IFCLabel;
  readonly schema: JSONSchema;

  /** The schema document that resolves local references inside `.schema`. */
  readonly root: JSONSchema;

  /**
   * Set when the declaration sits inside an `anyOf` or `oneOf` branch, so it
   * holds only for the values that branch matches.
   */
  readonly conditional?: true;
}

interface IfcSchemaVisit {
  root: object;
  schema: object;
  parent?: IfcSchemaVisit;
}

// The entries of each deep-frozen schema document, by the document. The
// entries embed resolved content, so a registry clear swaps the cache.
let documentEntries = new WeakMap<object, readonly CfcSchemaEntry[]>();
onSchemaRegistryClear(() => {
  documentEntries = new WeakMap();
});

// A visit that matches no schema, so the walk a kept document starts with
// is told apart from a whole-document ask.
const EMPTY_VISIT = {};

/**
 * Return every `ifc` declaration in a schema at its logical value path.
 *
 * Compound schemas contribute at their current path. Array items and
 * record-only additional properties use a wildcard path. Tuple entries use
 * their concrete index. Negated schemas do not describe labels on real data.
 * A declaration reached through an `anyOf` or `oneOf` branch is marked
 * `conditional`.
 */
export const cfcSchemaEntries = (
  schema: JSONSchema,
  path: readonly string[] = [],
  entries: CfcSchemaEntry[] = [],
  root: JSONSchema = schema,
  active?: IfcSchemaVisit,
  conditional = false,
): readonly CfcSchemaEntry[] => {
  // A whole document's entries are a function of the document and of the
  // schema documents its external references name, and a commit asks for a
  // candidate schema's entries once per check it makes, so a deep-frozen
  // document's are walked once and kept by its identity. A walk during
  // which a `cid:` resolution missed is not kept: the document it lacked
  // can arrive later, and its declarations with it. The kept array is
  // frozen: every reader iterates it.
  const wholeDocument = path.length === 0 && entries.length === 0 &&
    root === schema && active === undefined && !conditional;
  if (wholeDocument && isObjectOrArray(schema) && isDeepFrozen(schema)) {
    const kept = documentEntries.get(schema);
    if (kept !== undefined) return kept;
    const missesBefore = externalResolutionMissCount();
    const walked = cfcSchemaEntries(schema, path, entries, root, {
      root: schema,
      schema: EMPTY_VISIT,
    }, conditional);
    if (externalResolutionMissCount() === missesBefore) {
      documentEntries.set(schema, Object.freeze(walked));
    }
    return walked;
  }
  if (!isSubschema(schema) || typeof schema === "boolean") {
    return entries;
  }
  const schemaRoot = root;
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

  // A ref that did not resolve leaves `resolved` as the schema itself, whose
  // own `$defs` is inert under the root it sits in.
  const childRoot = resolved !== schema
    ? cfcSchemaResolvedRoot(
      resolved,
      resolveCfcSchemaRefRoot(schema, schemaRoot),
    )
    : schemaRoot;
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
      ...(conditional ? { conditional: true as const } : {}),
    });
  }

  const recordOnly = resolved.properties === undefined ||
    (isObjectOrArray(resolved.properties) &&
      Object.keys(resolved.properties).length === 0);
  const walk = (
    child: JSONSchema,
    childPath: readonly string[],
    childConditional = conditional,
  ) =>
    cfcSchemaEntries(
      child,
      childPath,
      entries,
      childRoot,
      nextActive,
      childConditional,
    );
  forEachSubschema(resolved, (child, keyword, key, index) => {
    switch (keyword) {
      case "properties":
        walk(child, [...path, key!]);
        break;
      case "anyOf":
      case "oneOf":
        walk(child, path, true);
        break;
      case "allOf":
        walk(child, path);
        break;
      case "items":
        // The wildcard covers tuple positions and the rest schema when
        // `.prefixItems` is present.
        walk(child, [...path, "*"]);
        break;
      case "prefixItems":
        walk(child, [...path, String(index!)]);
        break;
      case "additionalProperties":
        // A wildcard cannot express "all properties except the named ones".
        // It is exact only when the schema declares no named properties.
        if (recordOnly) {
          walk(child, [...path, "*"]);
        }
        break;
      case "not":
        // A negated schema does not describe declarations on real data.
        break;
      default:
        // Unknown structural keywords contribute at the current position.
        walk(child, path);
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
