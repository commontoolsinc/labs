import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import { isRecord } from "@commonfabric/utils/types";
import { getLogger } from "@commonfabric/utils/logger";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";
import { rendererVDOMSchema, vnodeSchema } from "@commonfabric/runner/schemas";
import { decodeJsonPointer } from "../link-types.ts";

const logger = getLogger("cfc");

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
  key === "ifc" || key === "asCell" || key === "asStream";

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

export const findCfcSchemaRefs = (
  schema: JSONSchema,
  refSet: Set<string> = new Set<string>(),
): void => {
  if (typeof schema === "boolean") {
    return;
  }
  if (schema.$ref !== undefined) {
    refSet.add(schema.$ref);
  }
  if (schema.type === "array") {
    if (schema.items !== undefined) {
      findCfcSchemaRefs(schema.items, refSet);
    }
    if (schema.prefixItems !== undefined) {
      for (const item of schema.prefixItems) {
        findCfcSchemaRefs(item, refSet);
      }
    }
  } else if (schema.type === "object") {
    if (schema.additionalProperties !== undefined) {
      findCfcSchemaRefs(schema.additionalProperties, refSet);
    }
    if (schema.properties !== undefined) {
      for (const propSchema of Object.values(schema.properties)) {
        findCfcSchemaRefs(propSchema, refSet);
      }
    }
  }
  const optSchemas = [
    ...(schema.anyOf ? schema.anyOf : []),
    ...(schema.oneOf ? schema.oneOf : []),
    ...(schema.allOf ? schema.allOf : []),
  ];
  for (const optSchema of optSchemas) {
    findCfcSchemaRefs(optSchema, refSet);
  }
};

export const resolveCfcSchemaRef = (
  fullSchema: JSONSchema,
  schemaRef: string,
): JSONSchema | undefined => {
  if (schemaRef in embeddedSchemas) {
    return embeddedSchemas[schemaRef];
  }
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

export const resolveCfcSchemaRefs = (
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
