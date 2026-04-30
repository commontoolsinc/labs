import type { JSONSchema } from "@commonfabric/api";
import {
  resolveSchemaForValidation,
  validateAgainstSchema,
} from "@commonfabric/runner/cfc";

export const MAX_SUBAGENT_RETURN_SCHEMA_BYTES = 32 * 1024;

export interface ParsedSubagentReturnSchema {
  schema: JSONSchema;
  bytes: number;
}

export interface SanitizedSubagentReturn {
  value: unknown;
  linkedStringCount: number;
}

const textBytes = (input: string): Uint8Array =>
  new TextEncoder().encode(input);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const jsonPointer = (path: readonly (string | number)[]): string =>
  path.length === 0
    ? ""
    : `/${
      path.map((segment) =>
        String(segment).replaceAll("~", "~0").replaceAll("/", "~1")
      ).join("/")
    }`;

const returnLink = (
  childRunId: string,
  path: readonly (string | number)[],
): { "@link": string } => ({
  "@link": `opaque:${encodeURIComponent(childRunId)}${
    path.length === 0 ? "" : `#${jsonPointer(path)}`
  }`,
});

const primitiveJsonValue = (value: unknown): boolean =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

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
    primitiveJsonValue(resolved.const)
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

const objectSchemaIsClosed = (schema: Record<string, unknown>): boolean =>
  schema.additionalProperties !== true &&
  typeof schema.additionalProperties !== "object";

const schemaDeclaresOpaqueLinkObject = (
  schema: JSONSchema,
  fullSchema: JSONSchema,
): boolean => {
  const resolved = resolveSchemaForValidation(schema, fullSchema);
  if (!isRecord(resolved)) {
    return false;
  }
  if (
    isRecord(resolved.properties) &&
    isRecord(resolved.properties["@link"]) &&
    resolved.properties["@link"].type === "string" &&
    Array.isArray(resolved.required) &&
    resolved.required.includes("@link") &&
    objectSchemaIsClosed(resolved)
  ) {
    return true;
  }
  if (Array.isArray(resolved.allOf)) {
    return resolved.allOf.some((branch) =>
      schemaDeclaresOpaqueLinkObject(branch, fullSchema)
    );
  }
  const oneOf = matchingBranch(
    resolved.oneOf,
    { "@link": "opaque:subagent-return" },
    fullSchema,
  );
  if (oneOf !== undefined) {
    return schemaDeclaresOpaqueLinkObject(oneOf, fullSchema);
  }
  return Array.isArray(resolved.anyOf) &&
    resolved.anyOf.some((branch) =>
      schemaDeclaresOpaqueLinkObject(branch, fullSchema)
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

const sanitizeValue = (
  value: unknown,
  schema: JSONSchema,
  fullSchema: JSONSchema,
  childRunId: string,
  path: readonly (string | number)[],
): SanitizedSubagentReturn => {
  const effectiveSchema = schemaForValue(schema, value, fullSchema);
  if (typeof value === "string") {
    if (schemaAllowsRawString(effectiveSchema, value, fullSchema)) {
      return { value, linkedStringCount: 0 };
    }
    return { value: returnLink(childRunId, path), linkedStringCount: 1 };
  }
  if (Array.isArray(value)) {
    let linkedStringCount = 0;
    const items = value.map((item, index) => {
      const sanitized = sanitizeValue(
        item,
        itemSchemaForIndex(effectiveSchema, fullSchema),
        fullSchema,
        childRunId,
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
      schemaDeclaresOpaqueLinkObject(effectiveSchema, fullSchema)
    ) {
      return { value, linkedStringCount: 0 };
    }
    const knownKeys = knownPropertyNames(effectiveSchema, fullSchema);
    if (Object.keys(value).some((key) => !knownKeys.has(key))) {
      return { value: returnLink(childRunId, path), linkedStringCount: 0 };
    }
    let linkedStringCount = 0;
    const entries = Object.entries(value).map(([key, child]) => {
      const sanitized = sanitizeValue(
        child,
        childSchemaForKey(effectiveSchema, key, fullSchema),
        fullSchema,
        childRunId,
        [...path, key],
      );
      linkedStringCount += sanitized.linkedStringCount;
      return [key, sanitized.value] as const;
    });
    return { value: Object.fromEntries(entries), linkedStringCount };
  }
  return { value, linkedStringCount: 0 };
};

export const parseSubagentReturnSchema = (
  input: unknown,
): ParsedSubagentReturnSchema | undefined => {
  if (input === undefined) {
    return undefined;
  }
  let parsed = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      throw new Error(
        "delegate_task returnSchema string must be valid JSON",
      );
    }
  }
  if (
    typeof parsed !== "boolean" &&
    (!isRecord(parsed) || Array.isArray(parsed))
  ) {
    throw new Error(
      "delegate_task returnSchema must be a JSON Schema object, boolean, or JSON string",
    );
  }
  const encoded = JSON.stringify(parsed);
  const bytes = textBytes(encoded).byteLength;
  if (bytes > MAX_SUBAGENT_RETURN_SCHEMA_BYTES) {
    throw new Error(
      `delegate_task returnSchema must be at most ${MAX_SUBAGENT_RETURN_SCHEMA_BYTES} bytes`,
    );
  }
  return {
    schema: parsed as JSONSchema,
    bytes,
  };
};

export const parseSubagentReturnJson = (text: string): unknown => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("child final response was empty");
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error("child final response was not valid JSON");
  }
};

export const validateAndSanitizeSubagentReturn = (
  options: {
    schema: JSONSchema;
    value: unknown;
    childRunId: string;
  },
): SanitizedSubagentReturn => {
  const failure = validateAgainstSchema(options.schema, options.value);
  if (failure !== undefined) {
    throw new Error(failure);
  }
  return sanitizeValue(
    options.value,
    options.schema,
    options.schema,
    options.childRunId,
    [],
  );
};
