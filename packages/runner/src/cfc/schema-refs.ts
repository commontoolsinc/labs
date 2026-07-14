import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import { isRecord } from "@commonfabric/utils/types";
import { getLogger } from "@commonfabric/utils/logger";
import { isDeepFrozen } from "@commonfabric/data-model/deep-freeze";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";
import { rendererVDOMSchema, vnodeSchema } from "@commonfabric/runner/schemas";
import { decodeJsonPointer } from "../link-types.ts";

const logger = getLogger("cfc");

type SchemaDefinitions = NonNullable<JSONSchemaObj["$defs"]>;

type SchemaRefSummary = {
  /** All refs below this fragment, excluding dormant `$defs` bodies. */
  all: ReadonlySet<string>;
  /** Local definition names resolved by this fragment's definition scope. */
  localDefinitions: ReadonlySet<string>;
};

type DefinitionIndex = {
  dependencies: Map<string, ReadonlySet<string>>;
  subsets: Map<string, SchemaDefinitions>;
};

const EMPTY_REFS: ReadonlySet<string> = new Set<string>();
const EMPTY_REF_SUMMARY: SchemaRefSummary = {
  all: EMPTY_REFS,
  localDefinitions: EMPTY_REFS,
};

// Memos for the pure schema-ref walks below, keyed by schema object identity.
// A walk populates summaries bottom-up for every visited fragment, so a root
// scan also prepares its child fragments for later schemaAtPath() lookups.
// Only deep-frozen schemas are cached: mutable schemas could be edited in place
// after caching. Definition dependency graphs and canonical subsets are keyed
// separately by the active `$defs` object, since the same fragment may be used
// with different local definition scopes.
const schemaRefSummaryCache = new WeakMap<object, SchemaRefSummary>();
const definitionIndexCache = new WeakMap<object, DefinitionIndex>();
const prunedSchemaCache = new WeakMap<object, JSONSchema>();

// Caching resolveCfcSchemaRef also makes its result identity-STABLE per
// (fullSchema, ref), which lets downstream identity-keyed hash/traverse caches
// hit instead of seeing a fresh spread per resolution.
const resolvedRefCache = new WeakMap<
  object,
  Map<string, JSONSchema | undefined>
>();

const embeddedSchemas: Record<string, JSONSchema> = {
  "https://commonfabric.org/schemas/vdom.json": rendererVDOMSchema,
  "https://commonfabric.org/schemas/vnode.json": vnodeSchema,
};

const isRootDefsSchemaPointer = (pathToDef: readonly string[]): boolean =>
  pathToDef.length === 3 && pathToDef[0] === "#" && pathToDef[1] === "$defs" &&
  pathToDef[2].length > 0;

export const isEmbeddedCfcSchemaRef = (schemaRef: string): boolean =>
  schemaRef in embeddedSchemas;

export const cfcSchemaToObject = (schema?: JSONSchema): JSONSchemaObj =>
  (schema === true || schema === undefined)
    ? {}
    : schema === false
    ? { not: true }
    : schema;

export const cfcSchemaIsInternalKey = (key: string): boolean =>
  key === "ifc" || key === "asCell" || key === "asStream" ||
  key === "scope";

export const cfcSchemaIsTrue = (schema: JSONSchema): boolean => {
  if (schema === true) {
    return true;
  }
  return isRecord(schema) &&
    Object.keys(schema).every((key) =>
      cfcSchemaIsInternalKey(key) || key === "default" || key === "$defs"
    );
};

export const cfcSchemaIsFalse = (schema: JSONSchema): boolean =>
  schema === false ||
  (isRecord(schema) && "not" in schema && cfcSchemaIsTrue(schema["not"]!));

const localDefinitionName = (schemaRef: string): string | undefined => {
  if (!schemaRef.startsWith("#")) return undefined;
  const path = decodeJsonPointer(schemaRef);
  return isRootDefsSchemaPointer(path) ? path[2] : undefined;
};

const forEachSubschema = (
  schema: JSONSchemaObj,
  visit: (child: JSONSchema) => void,
): void => {
  if (schema.not !== undefined) visit(schema.not);
  if (schema.if !== undefined) visit(schema.if);
  if (schema.then !== undefined) visit(schema.then);
  if (schema.else !== undefined) visit(schema.else);
  if (schema.items !== undefined) visit(schema.items);
  if (schema.contains !== undefined) visit(schema.contains);
  if (schema.additionalProperties !== undefined) {
    visit(schema.additionalProperties);
  }
  if (schema.propertyNames !== undefined) visit(schema.propertyNames);
  if (schema.contentSchema !== undefined) visit(schema.contentSchema);

  for (const child of schema.allOf ?? []) visit(child);
  for (const child of schema.anyOf ?? []) visit(child);
  for (const child of schema.oneOf ?? []) visit(child);
  for (const child of schema.prefixItems ?? []) visit(child);
  for (const child of Object.values(schema.dependentSchemas ?? {})) {
    visit(child);
  }
  for (const child of Object.values(schema.properties ?? {})) visit(child);
  for (const child of Object.values(schema.patternProperties ?? {})) {
    visit(child);
  }
};

const addRefs = (target: Set<string>, source: ReadonlySet<string>): void => {
  for (const ref of source) target.add(ref);
};

const summarizeCfcSchemaRefs = (schema: JSONSchema): SchemaRefSummary => {
  if (typeof schema === "boolean") return EMPTY_REF_SUMMARY;
  const cached = schemaRefSummaryCache.get(schema);
  if (cached !== undefined) return cached;

  const all = new Set<string>();
  const localDefinitions = new Set<string>();
  if (schema.$ref !== undefined) {
    all.add(schema.$ref);
    const name = localDefinitionName(schema.$ref);
    if (name !== undefined) localDefinitions.add(name);
  }
  forEachSubschema(schema, (child) => {
    const childSummary = summarizeCfcSchemaRefs(child);
    addRefs(all, childSummary.all);
    // A child carrying its own `$defs` starts a new local-ref scope. Its refs
    // still count for the public findRefs() walk, but must not retain names in
    // the parent's definition map.
    if (!(isRecord(child) && child.$defs !== undefined)) {
      addRefs(localDefinitions, childSummary.localDefinitions);
    }
  });

  const summary: SchemaRefSummary = {
    all: all.size === 0 ? EMPTY_REFS : all,
    localDefinitions: localDefinitions.size === 0
      ? EMPTY_REFS
      : localDefinitions,
  };
  if (isDeepFrozen(schema)) schemaRefSummaryCache.set(schema, summary);
  return summary;
};

export const findCfcSchemaRefs = (
  schema: JSONSchema,
  refSet: Set<string> = new Set<string>(),
): void => {
  addRefs(refSet, summarizeCfcSchemaRefs(schema).all);
};

const definitionIndexFor = (
  definitions: SchemaDefinitions,
): { index: DefinitionIndex; cacheable: boolean } => {
  const cacheable = isDeepFrozen(definitions);
  if (!cacheable) {
    return {
      index: { dependencies: new Map(), subsets: new Map() },
      cacheable,
    };
  }
  let index = definitionIndexCache.get(definitions);
  if (index === undefined) {
    index = { dependencies: new Map(), subsets: new Map() };
    definitionIndexCache.set(definitions, index);
  }
  return { index, cacheable };
};

const definitionDependencies = (
  name: string,
  definitions: SchemaDefinitions,
  index: DefinitionIndex,
): ReadonlySet<string> => {
  const cached = index.dependencies.get(name);
  if (cached !== undefined) return cached;
  const definition = definitions[name];
  // resolveCfcSchemaRef() attaches the containing definition map to a reached
  // definition body. Nested children with their own `$defs` remain scope
  // boundaries (captured by `summary.localDefinitions`), but refs local to the
  // definition body itself therefore depend on this containing map.
  const dependencies = definition === undefined
    ? EMPTY_REFS
    : summarizeCfcSchemaRefs(definition).localDefinitions;
  index.dependencies.set(name, dependencies);
  return dependencies;
};

const definitionSetKey = (names: readonly string[]): string => {
  let key = "";
  for (const name of names) key += `${name.length}:${name}`;
  return key;
};

/**
 * Return the minimal active `$defs` map needed by `schema`'s local refs.
 *
 * Definition bodies are scanned lazily and only when reachable. Frozen schema
 * fragments populate reusable ref summaries bottom-up, while frozen definition
 * maps reuse dependency closures and canonical subset objects across callers.
 */
export const selectReferencedCfcSchemaDefs = (
  schema: JSONSchema,
  inheritedDefinitions?: SchemaDefinitions,
): SchemaDefinitions | undefined => {
  if (typeof schema === "boolean") return undefined;
  const definitions = schema.$defs ?? inheritedDefinitions;
  if (definitions === undefined) return undefined;

  const initial = summarizeCfcSchemaRefs(schema).localDefinitions;
  if (initial.size === 0) return undefined;

  const { index, cacheable } = definitionIndexFor(definitions);
  const needed = new Set<string>();
  const pending = [...initial];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (needed.has(name) || definitions[name] === undefined) continue;
    needed.add(name);
    for (
      const dependency of definitionDependencies(
        name,
        definitions,
        index,
      )
    ) {
      if (!needed.has(dependency)) pending.push(dependency);
    }
  }
  if (needed.size === 0) return undefined;

  const names = [...needed].toSorted();
  const key = definitionSetKey(names);
  if (cacheable) {
    const cached = index.subsets.get(key);
    if (cached !== undefined) return cached;
  }

  const subset: Record<string, JSONSchema> = {};
  for (const name of names) subset[name] = definitions[name];
  if (!cacheable) return subset;

  // Intern once so every derived schema sharing this closure also shares one
  // frozen, deterministically ordered `$defs` object.
  const holder = internSchema({ $defs: subset });
  const canonical = (holder as JSONSchemaObj).$defs!;
  index.subsets.set(key, canonical);
  return canonical;
};

/** Remove definitions that cannot be reached from this schema document. */
export const pruneCfcSchemaDefinitions = (schema: JSONSchema): JSONSchema => {
  if (typeof schema === "boolean" || schema.$defs === undefined) return schema;
  const cacheable = isDeepFrozen(schema);
  if (cacheable) {
    const cached = prunedSchemaCache.get(schema);
    if (cached !== undefined) return cached;
  }

  const selected = selectReferencedCfcSchemaDefs(schema);
  if (selected === schema.$defs) return schema;
  const result = { ...schema } as Record<string, unknown>;
  delete result.$defs;
  if (selected !== undefined) result.$defs = selected;
  const pruned = cacheable
    ? internSchema(result as JSONSchemaObj)
    : result as JSONSchemaObj;
  if (cacheable) prunedSchemaCache.set(schema, pruned);
  return pruned;
};

export const resolveCfcSchemaRef = (
  fullSchema: JSONSchema,
  schemaRef: string,
): JSONSchema | undefined => {
  if (schemaRef in embeddedSchemas) {
    return embeddedSchemas[schemaRef];
  }
  const cacheable = isRecord(fullSchema) && isDeepFrozen(fullSchema);
  if (cacheable) {
    const byRef = resolvedRefCache.get(fullSchema);
    if (byRef !== undefined && byRef.has(schemaRef)) {
      return byRef.get(schemaRef);
    }
  }
  const result = resolveCfcSchemaRefUncached(fullSchema, schemaRef);
  if (cacheable) {
    let byRef = resolvedRefCache.get(fullSchema as object);
    if (byRef === undefined) {
      byRef = new Map();
      resolvedRefCache.set(fullSchema as object, byRef);
    }
    byRef.set(schemaRef, result);
  }
  return result;
};

const resolveCfcSchemaRefUncached = (
  fullSchema: JSONSchema,
  schemaRef: string,
): JSONSchema | undefined => {
  if (!schemaRef.startsWith("#")) {
    logger.warn("cfc", () => ["Unsupported $ref in schema: ", schemaRef]);
    return undefined;
  }
  const pathToDef = decodeJsonPointer(schemaRef);
  if (pathToDef[0] !== "#") {
    logger.warn(
      "cfc",
      () => ["Unsupported anchor $ref in schema: ", schemaRef],
    );
    return undefined;
  }
  if (!isRootDefsSchemaPointer(pathToDef)) {
    logger.warn("cfc", () => [
      "Unsupported local $ref in schema (only #/$defs/<name> is supported): ",
      schemaRef,
    ]);
    return undefined;
  }
  let schemaCursor: unknown = fullSchema;
  for (let i = 1; i < pathToDef.length; i++) {
    if (!isRecord(schemaCursor) || !(pathToDef[i] in schemaCursor)) {
      logger.warn("cfc", () => [
        "Unresolved $ref in schema: ",
        schemaRef,
        fullSchema,
      ]);
      return undefined;
    }
    schemaCursor = schemaCursor[pathToDef[i]];
  }
  if (typeof schemaCursor === "object") {
    const schemaRefs = new Set<string>();
    findCfcSchemaRefs(schemaCursor as JSONSchema, schemaRefs);
    if (schemaRefs.size > 0) {
      schemaCursor = {
        ...schemaCursor,
        ...(isRecord(fullSchema) && fullSchema.$defs &&
          { $defs: fullSchema.$defs }),
      };
    }
  }
  return schemaCursor as JSONSchema;
};

// resolveCfcSchemaRefs results per (frozen schemaObj, frozen fullSchema)
// identity pair. The loop body builds a fresh `{...resolved, ...rest, $defs}`
// spread whenever a $ref schema carries extra keys (e.g. `{$ref, $defs}` —
// the rendererVDOMSchema read path), and that fresh object then re-paid a
// full content hash at downstream interning on every read. A sentinel marks
// `undefined` results so failed resolutions are memoized too.
const RESOLVED_UNDEFINED = Symbol("resolved-undefined");
const resolvedRefsCache = new WeakMap<
  object,
  WeakMap<object, JSONSchema | typeof RESOLVED_UNDEFINED>
>();

export const resolveCfcSchemaRefs = (
  schemaObj: JSONSchemaObj,
  fullSchema: JSONSchema = schemaObj,
): JSONSchema | undefined => {
  const cacheable = isDeepFrozen(schemaObj) &&
    (fullSchema === schemaObj ||
      (isRecord(fullSchema) && isDeepFrozen(fullSchema)));
  let byFull: WeakMap<object, JSONSchema | typeof RESOLVED_UNDEFINED>;
  if (cacheable) {
    const fullKey = fullSchema as object;
    let existing = resolvedRefsCache.get(schemaObj);
    if (existing === undefined) {
      existing = new WeakMap();
      resolvedRefsCache.set(schemaObj, existing);
    }
    byFull = existing;
    const cached = byFull.get(fullKey);
    if (cached !== undefined) {
      return cached === RESOLVED_UNDEFINED ? undefined : cached;
    }
    // Intern the result so the cached instance is canonical and frozen —
    // downstream identity-keyed caches then hit, and sharing it across callers
    // is safe. Primitive and `undefined` results intern to themselves.
    const raw = resolveCfcSchemaRefsUncached(schemaObj, fullSchema);
    const result = internSchema(raw);
    byFull.set(fullKey, result === undefined ? RESOLVED_UNDEFINED : result);
    return result;
  }
  return resolveCfcSchemaRefsUncached(schemaObj, fullSchema);
};

const resolveCfcSchemaRefsUncached = (
  schemaObj: JSONSchemaObj,
  fullSchema: JSONSchema = schemaObj,
): JSONSchema | undefined => {
  const seenRefs = new Set<string>();
  while (true) {
    const { $ref, ...rest } = schemaObj;
    if ($ref === undefined) {
      return schemaObj;
    }
    if (seenRefs.has($ref)) {
      return undefined;
    }
    seenRefs.add($ref);
    const resolved = resolveCfcSchemaRef(fullSchema, $ref);
    if (resolved === undefined) {
      return undefined;
    }
    if ($ref in embeddedSchemas) {
      fullSchema = resolved;
    }
    if (Object.keys(rest).length > 0) {
      if (isRecord(resolved)) {
        schemaObj = {
          ...resolved,
          ...rest,
          ...(isRecord(fullSchema) && fullSchema.$defs &&
            { $defs: fullSchema.$defs }),
        } as JSONSchemaObj;
      } else {
        schemaObj = {
          ...cfcSchemaToObject(resolved),
          ...rest,
        } as JSONSchemaObj;
      }
    } else if (typeof resolved === "boolean") {
      return resolved;
    } else {
      schemaObj = resolved;
    }
  }
};

export const resolveCfcSchemaRefsOrThrow = (
  schemaObj: JSONSchemaObj,
  fullSchema: JSONSchema = schemaObj,
): JSONSchema => {
  if (!isRecord(fullSchema)) {
    throw new Error("Found $ref without fullSchema object");
  }
  const resolved = resolveCfcSchemaRefs(schemaObj, fullSchema);
  if (resolved === undefined) {
    const ref = "$ref" in schemaObj ? schemaObj.$ref : toCompactDebugString(
      schemaObj,
    );
    throw new Error(
      `Failed to resolve $ref: ${ref}. ` +
        (typeof ref === "string" && ref.startsWith("http")
          ? `External $ref URLs must be registered in embeddedSchemas (packages/runner/src/cfc/schema-refs.ts). ` +
            `If you added a new native type to NATIVE_TYPE_SCHEMAS in ` +
            `packages/schema-generator/src/formatters/native-type-formatter.ts, ` +
            `add its schema to embeddedSchemas as well.`
          : `Schema: ${toCompactDebugString(schemaObj)}`),
    );
  }
  return resolved;
};
