import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import { isRecord } from "@commonfabric/utils/types";
import { getLogger } from "@commonfabric/utils/logger";
import { isDeepFrozen } from "@commonfabric/data-model/deep-freeze";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";
import { rendererVDOMSchema, vnodeSchema } from "@commonfabric/runner/schemas";
import { decodeJsonPointer } from "../link-types.ts";

const logger = getLogger("cfc");

// Memos for the pure schema-ref walks below, keyed by schema object identity.
// Only deep-frozen schemas are cached (isDeepFrozen is O(1) for graphs it has
// seen): mutable schemas could be edited in place after caching. The interned
// schemas on the hot read path (e.g. rendererVDOMSchema) are deep-frozen, so
// they hit. Caching resolveCfcSchemaRef also makes its result identity-STABLE
// per (fullSchema, ref), which lets downstream identity-keyed hash/traverse
// caches hit instead of seeing a fresh spread per resolution.
const schemaRefsCache = new WeakMap<object, ReadonlySet<string>>();
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

const collectCfcSchemaRefs = (
  schema: JSONSchema,
  refSet: Set<string>,
): void => {
  if (typeof schema === "boolean") {
    return;
  }
  const cached = schemaRefsCache.get(schema);
  if (cached !== undefined) {
    for (const ref of cached) refSet.add(ref);
    return;
  }
  if (schema.$ref !== undefined) {
    refSet.add(schema.$ref);
  }
  if (schema.type === "array") {
    if (schema.items !== undefined) {
      collectCfcSchemaRefs(schema.items, refSet);
    }
    if (schema.prefixItems !== undefined) {
      for (const item of schema.prefixItems) {
        collectCfcSchemaRefs(item, refSet);
      }
    }
  } else if (schema.type === "object") {
    if (schema.additionalProperties !== undefined) {
      collectCfcSchemaRefs(schema.additionalProperties, refSet);
    }
    if (schema.properties !== undefined) {
      for (const propSchema of Object.values(schema.properties)) {
        collectCfcSchemaRefs(propSchema, refSet);
      }
    }
  }
  const optSchemas = [
    ...(schema.anyOf ? schema.anyOf : []),
    ...(schema.oneOf ? schema.oneOf : []),
    ...(schema.allOf ? schema.allOf : []),
  ];
  for (const optSchema of optSchemas) {
    collectCfcSchemaRefs(optSchema, refSet);
  }
};

export const findCfcSchemaRefs = (
  schema: JSONSchema,
  refSet: Set<string> = new Set<string>(),
): void => {
  if (typeof schema === "boolean") {
    return;
  }
  const cached = schemaRefsCache.get(schema);
  if (cached !== undefined) {
    for (const ref of cached) refSet.add(ref);
    return;
  }
  const collected = new Set<string>();
  collectCfcSchemaRefs(schema, collected);
  if (isDeepFrozen(schema)) {
    schemaRefsCache.set(schema, collected);
  }
  for (const ref of collected) refSet.add(ref);
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
