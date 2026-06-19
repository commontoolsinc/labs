import type { JSONSchema } from "@commonfabric/api";
import { isRecord } from "@commonfabric/utils/types";
import { cfcOpaqueLinkForPath } from "./observation.ts";
import {
  cfcObjectSchemaIsClosed,
  isPrimitiveJsonValue,
  resolveSchemaForValidation,
  validateAgainstSchema,
} from "./schema-sanitization.ts";

export interface SchemaOpaqueLinkSanitizationResult {
  value: unknown;
  linkedStringCount: number;
}

export const validateStructuredResultValue = (
  options: {
    schema: JSONSchema;
    value: unknown;
  },
): void => {
  const failure = validateAgainstSchema(options.schema, options.value);
  if (failure !== undefined) {
    throw new Error(failure);
  }
};

const schemaAllowsRawString = (
  schema: JSONSchema,
  value: string,
  fullSchema: JSONSchema,
): boolean => {
  const resolved = resolveSchemaForValidation(schema, fullSchema);
  if (!isRecord(resolved)) {
    return false;
  }
  if (Array.isArray(resolved.enum)) {
    return resolved.enum.some((entry) => entry === value);
  }
  if (
    "const" in resolved && resolved.const === value &&
    isPrimitiveJsonValue(resolved.const)
  ) {
    return true;
  }
  if (Array.isArray(resolved.allOf)) {
    return resolved.allOf.some((branch) =>
      schemaAllowsRawString(branch, value, fullSchema)
    );
  }
  const oneOf = matchingBranch(resolved.oneOf, value, fullSchema);
  if (oneOf !== undefined) {
    return schemaAllowsRawString(oneOf, value, fullSchema);
  }
  if (Array.isArray(resolved.anyOf)) {
    return resolved.anyOf.some((branch) =>
      validateAgainstSchema(branch, value, fullSchema) === undefined &&
      schemaAllowsRawString(branch, value, fullSchema)
    );
  }
  return false;
};

const schemaDirectlyDeclaresOpaqueLinkObject = (
  schema: Record<string, unknown>,
): boolean =>
  isRecord(schema.properties) &&
  isRecord(schema.properties["@link"]) &&
  schema.properties["@link"].type === "string" &&
  Array.isArray(schema.required) &&
  schema.required.includes("@link") &&
  cfcObjectSchemaIsClosed(schema);

const matchingBranches = (
  branches: unknown,
  value: unknown,
  fullSchema: JSONSchema,
): JSONSchema[] => {
  if (!Array.isArray(branches)) {
    return [];
  }
  return branches
    .filter((branch): branch is JSONSchema =>
      (typeof branch === "boolean" || isRecord(branch)) &&
      validateAgainstSchema(branch, value, fullSchema) === undefined
    )
    .map((branch) => resolveSchemaForValidation(branch, fullSchema));
};

const schemaAcceptsOpaqueLinkObject = (
  schema: JSONSchema,
  value: { "@link": string },
  fullSchema: JSONSchema,
): boolean => {
  const resolved = resolveSchemaForValidation(schema, fullSchema);
  if (!isRecord(resolved)) {
    return false;
  }
  if (validateAgainstSchema(resolved, value, fullSchema) !== undefined) {
    return false;
  }
  if (schemaDirectlyDeclaresOpaqueLinkObject(resolved)) {
    return true;
  }
  if (Array.isArray(resolved.allOf)) {
    return resolved.allOf.some((branch) =>
      schemaAcceptsOpaqueLinkObject(branch, value, fullSchema)
    );
  }
  const oneOfBranches = matchingBranches(resolved.oneOf, value, fullSchema);
  if (oneOfBranches.length > 0) {
    return oneOfBranches.some((branch) =>
      schemaAcceptsOpaqueLinkObject(branch, value, fullSchema)
    );
  }
  return matchingBranches(resolved.anyOf, value, fullSchema).some((branch) =>
    schemaAcceptsOpaqueLinkObject(branch, value, fullSchema)
  );
};

const valueIsOpaqueLinkObject = (
  value: unknown,
): value is { "@link": string } =>
  isRecord(value) &&
  typeof value["@link"] === "string" &&
  Object.keys(value).length === 1;

const matchingBranch = (
  branches: unknown,
  value: unknown,
  fullSchema: JSONSchema,
): JSONSchema | undefined => {
  if (!Array.isArray(branches)) {
    return undefined;
  }
  const branch = branches.find((branch): branch is JSONSchema =>
    (typeof branch === "boolean" || isRecord(branch)) &&
    validateAgainstSchema(branch, value, fullSchema) === undefined
  );
  return branch === undefined
    ? undefined
    : resolveSchemaForValidation(branch, fullSchema);
};

const isEmptySchemaObject = (schema: JSONSchema): boolean =>
  isRecord(schema) && Object.keys(schema).length === 0;

const combineAllOf = (schemas: readonly JSONSchema[]): JSONSchema => {
  const constrained = schemas.filter((schema) =>
    schema !== true && !isEmptySchemaObject(schema)
  );
  if (constrained.some((schema) => schema === false)) {
    return false;
  }
  if (constrained.length === 0) {
    return true;
  }
  if (constrained.length === 1) {
    return constrained[0]!;
  }
  return { allOf: constrained };
};

const schemaWithoutBranchKeyword = (
  schema: Record<string, unknown>,
  keyword: "anyOf" | "oneOf",
): JSONSchema => {
  const { [keyword]: _ignored, ...rest } = schema;
  return rest as JSONSchema;
};

const schemaForValue = (
  schema: JSONSchema,
  value: unknown,
  fullSchema: JSONSchema,
): JSONSchema => {
  const resolved = resolveSchemaForValidation(schema, fullSchema);
  if (!isRecord(resolved)) {
    return resolved;
  }
  let base: JSONSchema = resolved;
  const branches: JSONSchema[] = [];
  const oneOf = matchingBranch(resolved.oneOf, value, fullSchema);
  if (oneOf !== undefined) {
    base = schemaWithoutBranchKeyword(base as Record<string, unknown>, "oneOf");
    branches.push(oneOf);
  }
  const anyOf = matchingBranch(resolved.anyOf, value, fullSchema);
  if (anyOf !== undefined) {
    base = schemaWithoutBranchKeyword(base as Record<string, unknown>, "anyOf");
    branches.push(anyOf);
  }
  return branches.length === 0 ? resolved : combineAllOf([base, ...branches]);
};

const childSchemaForKey = (
  schema: JSONSchema,
  key: string,
  fullSchema: JSONSchema,
): JSONSchema => {
  const resolved = resolveSchemaForValidation(schema, fullSchema);
  if (!isRecord(resolved)) {
    return true;
  }
  const childSchemas: JSONSchema[] = [];
  if (isRecord(resolved.properties)) {
    const child = resolved.properties[key];
    if (typeof child === "boolean" || isRecord(child)) {
      childSchemas.push(child);
    }
  }
  if (
    !(isRecord(resolved.properties) && key in resolved.properties) &&
    (typeof resolved.additionalProperties === "boolean" ||
      isRecord(resolved.additionalProperties))
  ) {
    childSchemas.push(resolved.additionalProperties);
  }
  if (Array.isArray(resolved.allOf)) {
    for (const branch of resolved.allOf) {
      const child = childSchemaForKey(branch, key, fullSchema);
      if (child !== true) {
        childSchemas.push(child);
      }
    }
  }
  return combineAllOf(childSchemas);
};

const knownPropertyNames = (
  schema: JSONSchema,
  fullSchema: JSONSchema,
): Set<string> => {
  const resolved = resolveSchemaForValidation(schema, fullSchema);
  const known = new Set<string>();
  if (!isRecord(resolved)) {
    return known;
  }
  if (isRecord(resolved.properties)) {
    for (const key of Object.keys(resolved.properties)) {
      known.add(key);
    }
  }
  for (
    const branches of [resolved.allOf, resolved.anyOf, resolved.oneOf] as const
  ) {
    if (!Array.isArray(branches)) {
      continue;
    }
    for (const branch of branches) {
      for (const key of knownPropertyNames(branch, fullSchema)) {
        known.add(key);
      }
    }
  }
  return known;
};

const itemSchemaForIndex = (
  schema: JSONSchema,
  fullSchema: JSONSchema,
): JSONSchema => {
  const resolved = resolveSchemaForValidation(schema, fullSchema);
  const itemSchemas: JSONSchema[] = [];
  if (
    isRecord(resolved) &&
    (typeof resolved.items === "boolean" || isRecord(resolved.items))
  ) {
    itemSchemas.push(resolved.items);
  }
  if (isRecord(resolved) && Array.isArray(resolved.allOf)) {
    for (const branch of resolved.allOf) {
      const item = itemSchemaForIndex(branch, fullSchema);
      if (item !== true) {
        itemSchemas.push(item);
      }
    }
  }
  return combineAllOf(itemSchemas);
};

// TODO(danfuzz): Latent — schemas don't admit `Fabric*` values on this path
// today, but will in the not-too-distant future; at that point this guard-less
// `isRecord`-walk fails (a `FabricPrimitive` is decomposed, a `FabricInstance`
// is walked by internal slots rather than codec contents). Mark ahead of that.
const sanitizeValueWithOpaqueLinks = (
  value: unknown,
  schema: JSONSchema,
  fullSchema: JSONSchema,
  opaqueHandleId: string,
  path: readonly (string | number)[],
): SchemaOpaqueLinkSanitizationResult => {
  const effectiveSchema = schemaForValue(schema, value, fullSchema);
  if (typeof value === "string") {
    if (schemaAllowsRawString(effectiveSchema, value, fullSchema)) {
      return { value, linkedStringCount: 0 };
    }
    return {
      value: cfcOpaqueLinkForPath(opaqueHandleId, path),
      linkedStringCount: 1,
    };
  }
  if (Array.isArray(value)) {
    let linkedStringCount = 0;
    const items = value.map((item, index) => {
      const sanitized = sanitizeValueWithOpaqueLinks(
        item,
        itemSchemaForIndex(effectiveSchema, fullSchema),
        fullSchema,
        opaqueHandleId,
        [...path, index],
      );
      linkedStringCount += sanitized.linkedStringCount;
      return sanitized.value;
    });
    return { value: items, linkedStringCount };
  }
  if (isRecord(value)) {
    if (
      valueIsOpaqueLinkObject(value) &&
      schemaAcceptsOpaqueLinkObject(schema, value, fullSchema)
    ) {
      return { value, linkedStringCount: 0 };
    }
    const knownKeys = knownPropertyNames(effectiveSchema, fullSchema);
    if (Object.keys(value).some((key) => !knownKeys.has(key))) {
      return {
        value: cfcOpaqueLinkForPath(opaqueHandleId, path),
        linkedStringCount: 0,
      };
    }
    let linkedStringCount = 0;
    const entries = Object.entries(value).map(([key, child]) => {
      const sanitized = sanitizeValueWithOpaqueLinks(
        child,
        childSchemaForKey(effectiveSchema, key, fullSchema),
        fullSchema,
        opaqueHandleId,
        [...path, key],
      );
      linkedStringCount += sanitized.linkedStringCount;
      return [key, sanitized.value] as const;
    });
    return { value: Object.fromEntries(entries), linkedStringCount };
  }
  return { value, linkedStringCount: 0 };
};

export const validateAndSanitizeSchemaValueWithOpaqueLinks = (
  options: {
    schema: JSONSchema;
    value: unknown;
    opaqueHandleId: string;
  },
): SchemaOpaqueLinkSanitizationResult => {
  validateStructuredResultValue(options);
  return sanitizeValueWithOpaqueLinks(
    options.value,
    options.schema,
    options.schema,
    options.opaqueHandleId,
    [],
  );
};

export const validateAndSanitizeStructuredResultValue =
  validateAndSanitizeSchemaValueWithOpaqueLinks;
