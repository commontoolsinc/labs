import { type ImmutableJSONValue, JSONSchemaObj } from "@commonfabric/api";
import { isRecord } from "@commonfabric/utils/types";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { isDeepFrozen } from "@commonfabric/data-model/deep-freeze";
import type {
  AsCellEntry,
  CellKind,
  JSONSchema,
  SchemaScope,
} from "./builder/types.ts";
import { isSchemaScope } from "./scope.ts";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { uniqueCfcAtoms } from "./cfc/observation.ts";
import {
  cfcSchemaChildRoot,
  cfcSchemaIsFalse,
  cfcSchemaIsInternalKey,
  cfcSchemaIsTrue,
  cfcSchemaToObject,
  findCfcSchemaRefs,
  resolveCfcSchemaRef,
  resolveCfcSchemaRefRoot,
  resolveCfcSchemaRefs,
  resolveCfcSchemaRefsOrThrow,
  selectReferencedCfcSchemaDefs,
} from "./cfc/schema-refs.ts";
import { forEachSubschema } from "./schema-walk.ts";
export {
  CFC_ATOM_TYPE,
  CFC_CONCEPT_KIND,
  CFC_FUSE_ATOM_CLASS,
  CFC_RUNTIME_SUBJECT,
  cfcAtom,
} from "@commonfabric/api/cfc";

type IFCAtom = ImmutableJSONValue;

// schemaAtPath derivations per deep-frozen schema identity. The derivation is
// pure given (schema, path, boolean default flags) when no extra
// confidentiality is passed — instance state never enters it (`lub` delegates
// to a static and has no subclasses) — and it runs per array element / object
// property on read and write-diff paths, so identical lookups repeat
// constantly. Module-level rather than per-instance: several hot paths create
// a fresh ContextualFlowControl per call (storage pull/watch, traversal
// contexts), which would leave a per-instance cache permanently cold.
// Mutable schemas are never cached (in-place edits must be observed).
const schemaAtPathCache = new WeakMap<object, Map<string, JSONSchema>>();
const SCHEMA_AT_PATH_CACHE_MAX_ENTRIES = 2_048;

type SymbolicSchemaAtPathClassifier = (part: string) => string;
const SYMBOLIC_CLASSIFIER_UNSUPPORTED = Symbol("unsupported");
const symbolicSchemaAtPathClassifierCache = new WeakMap<
  object,
  SymbolicSchemaAtPathClassifier | typeof SYMBOLIC_CLASSIFIER_UNSUPPORTED
>();

interface RootedSchemaVisit {
  root: object;
  schema: object;
  parent?: RootedSchemaVisit;
}

const rootedSchemaVisitIsActive = (
  visit: RootedSchemaVisit | undefined,
  root: object,
  schema: object,
): boolean => {
  for (let cursor = visit; cursor !== undefined; cursor = cursor.parent) {
    if (cursor.root === root && cursor.schema === schema) return true;
  }
  return false;
};

const buildSymbolicSchemaAtPathClassifier = (
  schema: JSONSchema,
  fullSchema: JSONSchema,
  active?: RootedSchemaVisit,
): SymbolicSchemaAtPathClassifier | undefined => {
  if (typeof schema === "boolean") return () => "boolean";
  const schemaRoot = cfcSchemaChildRoot(schema, fullSchema);
  const rootKey = isRecord(schemaRoot) ? schemaRoot : schema;
  if (rootedSchemaVisitIsActive(active, rootKey, schema)) return undefined;
  const nextActive = { root: rootKey, schema, parent: active };
  {
    if (schema.$ref !== undefined) {
      const resolved = resolveCfcSchemaRefs(schema, schemaRoot);
      if (resolved === undefined) return undefined;
      const nextFullSchema = cfcSchemaChildRoot(
        resolved,
        resolveCfcSchemaRefRoot(schema, schemaRoot),
      );
      return buildSymbolicSchemaAtPathClassifier(
        resolved,
        nextFullSchema,
        nextActive,
      );
    }
    if (Array.isArray(schema.type)) {
      const { type: _types, ...base } = schema;
      const classifiers: SymbolicSchemaAtPathClassifier[] = [];
      for (const type of schema.type) {
        const classifier = buildSymbolicSchemaAtPathClassifier(
          { ...base, type },
          schemaRoot,
          nextActive,
        );
        if (classifier === undefined) return undefined;
        classifiers.push(classifier);
      }
      return combineSymbolicSchemaClassifiers(classifiers);
    }
    if (schema.anyOf || schema.oneOf) {
      const options = (schema.anyOf && schema.oneOf)
        ? [...schema.anyOf, ...schema.oneOf]
        : schema.anyOf ?? schema.oneOf ?? [];
      const classifiers: SymbolicSchemaAtPathClassifier[] = [];
      for (const option of options) {
        const classifier = buildSymbolicSchemaAtPathClassifier(
          option,
          cfcSchemaChildRoot(option, schemaRoot),
          nextActive,
        );
        if (classifier === undefined) return undefined;
        classifiers.push(classifier);
      }
      return combineSymbolicSchemaClassifiers(classifiers);
    }
    if (cfcSchemaIsTrue(schema)) return () => "wildcard";
    if (schema.type === "object") {
      const properties = schema.properties;
      if (properties !== undefined) {
        const fallback = Object.keys(properties).length === 0
          ? "empty"
          : "missing";
        return (part) =>
          Object.hasOwn(properties, part)
            ? `property:${part.length}:${part}`
            : schema.additionalProperties !== undefined
            ? "additional"
            : fallback;
      }
      return schema.additionalProperties !== undefined
        ? () => "additional"
        : () => "open";
    }
    if (schema.type === "array") {
      const prefixItemCount = schema.prefixItems?.length ?? 0;
      return (part) => {
        if (!isArrayIndexPropertyName(part)) return "invalid-index";
        const index = Number(part);
        return index < prefixItemCount ? `prefix:${index}` : "items";
      };
    }
    if (
      schema.type === "unknown" ||
      Array.isArray(schema.type) && schema.type.includes("unknown")
    ) {
      return () => "unknown";
    }
    // schemaAtPath cannot descend through terminal primitive schemas.
    return () => "terminal";
  }
};

// The immediately repeated lookup is the dominant cache-hit case. One entry
// removes union-width cost without reintroducing raw path-part cardinality.
const combineSymbolicSchemaClassifiers = (
  classifiers: readonly SymbolicSchemaAtPathClassifier[],
): SymbolicSchemaAtPathClassifier => {
  const combinedKeyIds = new Map<string, string>();
  let memoPart: string | undefined;
  let memoKey = "";
  return (part) => {
    if (part === memoPart) return memoKey;
    let combinedKey = "union";
    for (const classifier of classifiers) {
      const childKey = classifier(part);
      combinedKey += `|${childKey.length}:${childKey}`;
    }
    let key = combinedKeyIds.get(combinedKey);
    if (key === undefined) {
      key = `union:${combinedKeyIds.size}`;
      combinedKeyIds.set(combinedKey, key);
    }
    memoPart = part;
    memoKey = key;
    return key;
  };
};

/**
 * A one-segment path key based on schema behavior rather than data cardinality.
 *
 * Homogeneous array indices and undeclared object property names all select the
 * same schema. Sharing those cache entries bounds the cache by schema shape
 * instead of by array length or dynamic object key count. For frozen schemas,
 * resolving the root ref/union structure once builds a reusable classifier for
 * later lookups. Unsupported shapes retain the bounded exact-path fallback.
 */
const symbolicSchemaAtPathPart = (
  schema: JSONSchemaObj,
  part: string,
): string | undefined => {
  let classifier = symbolicSchemaAtPathClassifierCache.get(schema);
  if (classifier === undefined) {
    classifier = buildSymbolicSchemaAtPathClassifier(
      schema,
      schema,
    ) ?? SYMBOLIC_CLASSIFIER_UNSUPPORTED;
    symbolicSchemaAtPathClassifierCache.set(schema, classifier);
  }
  return classifier === SYMBOLIC_CLASSIFIER_UNSUPPORTED
    ? undefined
    : classifier(part);
};

const schemaAtPathKey = (
  schema: JSONSchemaObj,
  path: readonly string[],
  defaultEmptyProperties: boolean,
  defaultMissingProperty: boolean,
): string => {
  let key = `${defaultEmptyProperties}|${defaultMissingProperty}`;
  if (path.length === 1) {
    const symbolic = symbolicSchemaAtPathPart(schema, path[0]);
    if (symbolic !== undefined) return `${key}|s:${symbolic}`;
  }
  // Length-prefix each segment so a segment containing the separator (a
  // NUL-bearing property name) cannot collide with a differently-split path.
  for (const part of path) key += `|${part.length}:${part}`;
  return key;
};

// Class for handling cfc rules.
// The spec's confidentiality model is based on structured atoms.
export class ContextualFlowControl {
  static uniqueAtoms(atoms: Iterable<unknown>): IFCAtom[] {
    return uniqueCfcAtoms(atoms);
  }

  static addIfcAtoms(
    joined: Set<unknown>,
    atoms: readonly IFCAtom[] | undefined,
  ): void {
    if (!Array.isArray(atoms)) {
      return;
    }
    for (const atom of atoms) {
      joined.add(atom);
    }
  }

  /**
   * Collect any required confidentiality atoms required by the schema.
   * This could be made more conservative by combining the schema with the object
   * If our object lacks any of the fields that would add confidentiality,
   * we don't need to consider them.
   *
   * @param joined set to which we will add any confidentiality atoms
   * @param schema the schema with tags
   * @param fullSchema the full schema with any $defs needed
   * @param cycleTracker used to avoid reference cycles
   */
  static joinSchema(
    joined: Set<unknown>,
    schema: JSONSchema,
    fullSchema: JSONSchema = schema,
    active?: RootedSchemaVisit,
  ): Set<unknown> {
    if (typeof schema === "boolean") {
      return joined;
    }
    // A resolved schema is often unique, since it's generated by combining
    // other schema. `internSchema()` returns the canonical (identity-unique)
    // schema object, so structurally-equal schemas collapse to the same
    // reference — the cycle tracker can then dedup by identity. Also
    // correctly handles non-JSON-compatible `FabricValue`s (e.g.
    // `FabricEpochNsec`, `FabricBytes`, `FabricHash`) that may appear in
    // schema `default` fields; plain `JSON.stringify` would silently
    // mis-encode them.
    const schemaRoot = cfcSchemaChildRoot(schema, fullSchema);
    const rootKey = isRecord(schemaRoot) ? schemaRoot : schema;
    const canonical = internSchema(schema) as JSONSchemaObj;
    if (rootedSchemaVisitIsActive(active, rootKey, canonical)) {
      // we've already joined this
      return joined;
    }
    const nextActive = { root: rootKey, schema: canonical, parent: active };
    if (schema.ifc) {
      ContextualFlowControl.addIfcAtoms(joined, schema.ifc.confidentiality);
    }
    // The LUB must union the atoms of every subschema a value could validate
    // against — one (anyOf/oneOf) or all (allOf) branches, every property,
    // every tuple slot, items and additionalProperties alike; a skipped
    // keyword is branch-local confidentiality silently dropped
    // (under-tainting fail-open, audit 1.6). `not` is unioned too: usually
    // its atoms describe values the data must NOT contain — a conservative
    // over-taint — but a nested `not` (not-of-not) re-selects values that DO
    // match the inner subschema, so skipping `not` could under-taint.
    forEachSubschema(schema, (child) => {
      ContextualFlowControl.joinSchema(
        joined,
        child,
        cfcSchemaChildRoot(child, schemaRoot),
        nextActive,
      );
    });
    if (schema.$ref) {
      // Follow the references
      const resolvedSchema = ContextualFlowControl.resolveSchemaRefsOrThrow(
        schema,
        schemaRoot,
      );
      const resolvedRoot = cfcSchemaChildRoot(
        resolvedSchema,
        resolveCfcSchemaRefRoot(schema, schemaRoot),
      );
      ContextualFlowControl.joinSchema(
        joined,
        resolvedSchema,
        resolvedRoot,
        nextActive,
      );
    }
    return joined;
  }

  // Get the joined confidentiality atoms from the schema.
  public lubSchema(
    schema: JSONSchema,
    extraConfidentiality?: Set<unknown>,
  ): IFCAtom[] | undefined {
    const confidentiality = (extraConfidentiality !== undefined)
      ? new Set<unknown>(extraConfidentiality)
      : new Set<unknown>();
    ContextualFlowControl.joinSchema(confidentiality, schema);

    return (confidentiality.size === 0) ? undefined : this.lub(confidentiality);
  }

  public lub(joined: Set<unknown>): IFCAtom[] {
    return ContextualFlowControl.uniqueAtoms(joined);
  }

  // Return a copy of the schema with joined confidentiality atoms.
  public schemaWithLub(
    schema: JSONSchema,
    confidentiality: readonly unknown[],
  ): JSONSchema {
    const joined = new Set<unknown>(confidentiality);
    if (isRecord(schema) && schema.ifc !== undefined) {
      ContextualFlowControl.addIfcAtoms(joined, schema.ifc.confidentiality);
    }
    // If we have no confidentiality, we can leave the schema
    if (joined.size === 0) {
      return schema;
    }
    // We don't really support "not" schemas, but it's the only good way we
    // have to attach ifc to a `false` schema.
    const schemaObj = ContextualFlowControl.toSchemaObj(schema);
    const restrictedSchema = {
      ...schemaObj,
      ifc: { ...schemaObj.ifc, confidentiality: this.lub(joined) },
    };
    return restrictedSchema;
  }

  /**
   * Convert a schema that may be undefined or boolean to an object version.
   *
   * @param schema optional schema to convert
   */
  static toSchemaObj(schema?: JSONSchema): JSONSchemaObj {
    return cfcSchemaToObject(schema);
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
    return resolveCfcSchemaRefs(schemaObj, fullSchema);
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
    return resolveCfcSchemaRef(fullSchema, schemaRef);
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
    return findCfcSchemaRefs(schema, refSet);
  }

  static resolveSchemaRefsOrThrow(
    schemaObj: JSONSchemaObj,
    fullSchema: JSONSchema = schemaObj,
  ) {
    return resolveCfcSchemaRefsOrThrow(schemaObj, fullSchema);
  }

  // This is a variant of schemaAtPath that allows for an undefined schema.
  // It will return the empty object instead of true and undefined instead of false.
  getSchemaAtPath(
    schema: JSONSchema | undefined,
    path: string[],
    extraConfidentiality?: Set<unknown>,
  ): JSONSchema | undefined {
    if (schema === undefined) {
      return undefined;
    }
    const result = this.schemaAtPath(schema, path, extraConfidentiality);
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
    extraConfidentiality?: Set<unknown>,
    defaultEmptyProperties: JSONSchema = true,
    defaultMissingProperty: JSONSchema = true,
  ): JSONSchema {
    if (schema === false) return false;
    if (schema === true && extraConfidentiality === undefined) return true;
    // Take defs from schema if available
    const defs = isRecord(schema) && schema.$defs ? schema.$defs : undefined;
    const cacheable = extraConfidentiality === undefined &&
      typeof defaultEmptyProperties === "boolean" &&
      typeof defaultMissingProperty === "boolean" &&
      isRecord(schema) && isDeepFrozen(schema);
    if (!cacheable) {
      return this.schemaAtPathInternal(
        schema,
        path,
        defs,
        extraConfidentiality,
        defaultEmptyProperties,
        defaultMissingProperty,
      );
    }
    let byKey = schemaAtPathCache.get(schema);
    if (byKey === undefined) {
      byKey = new Map();
      schemaAtPathCache.set(schema, byKey);
    }
    const key = schemaAtPathKey(
      schema,
      path,
      defaultEmptyProperties,
      defaultMissingProperty,
    );
    let result = byKey.get(key);
    if (result === undefined) {
      // Intern the derivation so the cached result is the canonical frozen
      // instance: downstream identity-keyed caches (standardization, value
      // hashing) hit instead of re-walking a fresh anyOf rebuild every time.
      result = internSchema(this.schemaAtPathInternal(
        schema,
        path,
        defs,
        undefined,
        defaultEmptyProperties,
        defaultMissingProperty,
      ));
      if (byKey.size >= SCHEMA_AT_PATH_CACHE_MAX_ENTRIES) byKey.clear();
      byKey.set(key, result);
    }
    return result;
  }

  private schemaAtPathInternal(
    schema: JSONSchema,
    path: readonly string[],
    defs: Record<string, JSONSchema> | undefined,
    extraConfidentiality: Set<unknown> | undefined,
    defaultEmptyProperties: JSONSchema,
    defaultMissingProperty: JSONSchema,
  ): JSONSchema {
    const joined = (extraConfidentiality !== undefined)
      ? new Set<unknown>(extraConfidentiality)
      : new Set<unknown>();
    let cursor = schema;
    for (
      const [index, part] of path.map((value, index) =>
        [index, value] as [number, string]
      )
    ) {
      // If the cursor is a $ref, get the target location
      if (isRecord(cursor) && "$ref" in cursor) {
        // Follow the reference
        cursor = ContextualFlowControl.resolveSchemaRefsOrThrow(
          cursor,
          { $defs: defs },
        );
        // Resolve schema refs can resolve to a fullSchema, in which case we
        // need to replace our defs.
        if (isRecord(cursor) && cursor.$defs) {
          defs = cursor.$defs;
        }
      }
      if (
        isRecord(cursor) &&
        (Array.isArray(cursor.type) || "anyOf" in cursor || "oneOf" in cursor)
      ) {
        const subSchemas = new Set<JSONSchema>();
        const cursorObject = cursor;
        const options = Array.isArray(cursorObject.type)
          ? cursorObject.type.map((type) => ({ ...cursorObject, type }))
          : (cursorObject.anyOf && cursorObject.oneOf)
          ? [...cursorObject.anyOf, ...cursorObject.oneOf]
          : cursorObject.anyOf ?? cursorObject.oneOf ?? [];
        for (const entry of options) {
          const entryDefs = isRecord(entry) && entry.$defs !== undefined
            ? entry.$defs as Record<string, JSONSchema>
            : defs;
          const optSchema = this.schemaAtPathInternal(
            entry,
            path.slice(index),
            entryDefs,
            extraConfidentiality,
            defaultEmptyProperties,
            defaultMissingProperty,
          );
          if (typeof optSchema !== "boolean" && typeof optSchema !== "object") {
            return optSchema;
          }
          const subSchema = optSchema as JSONSchema;
          if (subSchema === false) {
            continue;
          } else if (ContextualFlowControl.isTrueSchema(subSchema)) {
            cursor = true;
            break;
          } else {
            // `internSchema()` returns the canonical (identity-unique)
            // schema object, so structurally-equal schemas collapse to
            // the same reference. That gives identity-based dedup via
            // `Set<JSONSchema>`, and correctly handles non-JSON-compatible
            // `FabricValue`s (e.g. `FabricEpochNsec`, `FabricBytes`,
            // `FabricHash`) that may appear in schema `default` fields.
            subSchemas.add(internSchema(subSchema));
          }
        }
        // Only update cursor from subSchemas if the isTrueSchema branch
        // didn't already set cursor = true and break out of the loop.
        if (cursor !== true) {
          const subSchemaArr = [...subSchemas];
          if (subSchemaArr.length === 0) {
            cursor = false;
          } else if (subSchemaArr.length === 1) {
            cursor = subSchemaArr[0];
          } else {
            cursor = { "anyOf": subSchemaArr };
          }
        }
        break;
      }
      if (typeof cursor === "boolean") {
        break;
      } else if (ContextualFlowControl.isTrueSchema(cursor)) {
        // wildcard schema -- equivalent to true, but we can add ifc tags
        break;
      } else if (cursor.type === "object") {
        if (cursor.ifc !== undefined) {
          ContextualFlowControl.addIfcAtoms(
            joined,
            cursor.ifc.confidentiality,
          );
        }
        if (cursor.properties && Object.hasOwn(cursor.properties, part)) {
          const cursorObj = cursor.properties as Record<string, JSONSchema>;
          cursor = cursorObj[part];
          if (typeof cursor === "boolean") {
            break;
          } else {
            if (cursor.ifc !== undefined) {
              ContextualFlowControl.addIfcAtoms(
                joined,
                cursor.ifc.confidentiality,
              );
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
      } else if (
        cursor.type === "unknown" ||
        Array.isArray(cursor.type) && cursor.type.includes("unknown")
      ) {
        // we can descend into unknown, but we just get more unknown
        cursor = { type: "unknown", ...(cursor.ifc && { ifc: cursor.ifc }) };
      } else {
        // we can only descend into objects and arrays or unknown
        return false;
      }
      if (isRecord(cursor) && cursor.$defs) {
        defs = cursor.$defs;
      }
    }
    if (isRecord(cursor) && cursor.ifc !== undefined) {
      ContextualFlowControl.addIfcAtoms(joined, cursor.ifc.confidentiality);
    }
    if (typeof cursor === "boolean") {
      if (!cursor) {
        return false; // no need to attach tags -- we'll never match
      } else if (joined.size === 0) {
        return true; // no ifc tags -- can just return true
      }
      cursor = {}; // change to use the empty object schema, so we can attach ifc.
    }
    // If we've encountered any confidentiality atoms while walking down the
    // schema, we need to add them to the returned object.
    const ifc = (joined.size !== 0)
      ? { ...cursor.ifc, confidentiality: this.lub(joined) }
      : cursor.ifc;
    const selectedDefs = selectReferencedCfcSchemaDefs(cursor, defs);
    const result = { ...cursor, ...(ifc && { ifc }) } as Record<
      string,
      unknown
    >;
    delete result.$defs;
    if (selectedDefs !== undefined) result.$defs = selectedDefs;
    return result as JSONSchema;
  }

  // Check to see if the specified schema is one of the special values meaning
  // it should always validate.
  static isTrueSchema(schema: JSONSchema): boolean {
    return cfcSchemaIsTrue(schema);
  }

  // We don't need to check ID and ID_FIELD, since they won't be included
  // in Object.keys return values.
  static isInternalSchemaKey(key: string): boolean {
    return cfcSchemaIsInternalKey(key);
  }

  static isFalseSchema(schema: JSONSchema): boolean {
    return cfcSchemaIsFalse(schema);
  }

  // Utility function to handle the asCell array tag.
  static getAsCellValues(
    schema: JSONSchema | undefined,
  ): readonly AsCellEntry[] {
    if (isRecord(schema) && Array.isArray(schema.asCell)) {
      return schema.asCell;
    }
    return [];
  }

  static getAsCellKind(entry: AsCellEntry | undefined): CellKind | undefined {
    return typeof entry === "string" ? entry : entry?.kind;
  }

  static getAsCellScope(
    entry: AsCellEntry | undefined,
  ): SchemaScope | undefined {
    return typeof entry === "string" ? undefined : entry?.scope;
  }

  /**
   * The scope a schema declares at this level: the outermost `asCell` entry's
   * scope if present, otherwise the top-level `scope`. The outermost `asCell`
   * entry describes the immediate cell/slot (the addressing scope of the link
   * to it, and the read follow-cap for that immediate hop); the top-level
   * `scope` applies only when there is no `asCell` wrapper.
   *
   * This single precedence is used both for the read follow-cap (which link
   * scopes a read may follow — see link-resolution.ts / traverse.ts) and for
   * the write target scope (where content is stored — see data-updating.ts), so
   * the two never disagree. It is a schema-level declaration only; it must never
   * be stamped onto a navigated link's own scope (see CT-1623).
   */
  static getSchemaScopeCap(
    schema: JSONSchema | undefined,
  ): SchemaScope | undefined {
    if (!isRecord(schema)) return undefined;
    const entryScope = ContextualFlowControl.getAsCellScope(
      ContextualFlowControl.getAsCellValues(schema).at(0),
    );
    if (isSchemaScope(entryScope)) return entryScope;
    if (isSchemaScope(schema.scope)) return schema.scope;
    return undefined;
  }
}
