import type { JSONSchema } from "@commonfabric/api";
import { validateAgainstSchema } from "@commonfabric/runner/cfc";

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
  "@link": `cf-harness://subagent-return/${encodeURIComponent(childRunId)}#${
    jsonPointer(path)
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
): boolean => {
  if (!isRecord(schema)) {
    return false;
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.some((entry) => entry === value);
  }
  return "const" in schema && schema.const === value &&
    primitiveJsonValue(schema.const);
};

const schemaDeclaresOpaqueLinkObject = (schema: JSONSchema): boolean =>
  isRecord(schema) &&
  isRecord(schema.properties) &&
  isRecord(schema.properties["@link"]) &&
  schema.properties["@link"].type === "string" &&
  Array.isArray(schema.required) &&
  schema.required.includes("@link") &&
  schema.additionalProperties === false;

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
  return branches.find((branch): branch is JSONSchema =>
    (typeof branch === "boolean" || isRecord(branch)) &&
    validateAgainstSchema(branch, value, fullSchema) === undefined
  );
};

const schemaForValue = (
  schema: JSONSchema,
  value: unknown,
  fullSchema: JSONSchema,
): JSONSchema => {
  if (!isRecord(schema)) {
    return schema;
  }
  const oneOf = matchingBranch(schema.oneOf, value, fullSchema);
  if (oneOf !== undefined) {
    return oneOf;
  }
  const anyOf = matchingBranch(schema.anyOf, value, fullSchema);
  if (anyOf !== undefined) {
    return anyOf;
  }
  return schema;
};

const childSchemaForKey = (
  schema: JSONSchema,
  key: string,
): JSONSchema => {
  if (!isRecord(schema)) {
    return true;
  }
  if (isRecord(schema.properties)) {
    const child = schema.properties[key];
    if (typeof child === "boolean" || isRecord(child)) {
      return child;
    }
  }
  if (
    typeof schema.additionalProperties === "boolean" ||
    isRecord(schema.additionalProperties)
  ) {
    return schema.additionalProperties;
  }
  return true;
};

const itemSchemaForIndex = (
  schema: JSONSchema,
): JSONSchema => {
  if (
    isRecord(schema) &&
    (typeof schema.items === "boolean" || isRecord(schema.items))
  ) {
    return schema.items;
  }
  return true;
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
    if (schemaAllowsRawString(effectiveSchema, value)) {
      return { value, linkedStringCount: 0 };
    }
    return { value: returnLink(childRunId, path), linkedStringCount: 1 };
  }
  if (Array.isArray(value)) {
    let linkedStringCount = 0;
    const items = value.map((item, index) => {
      const sanitized = sanitizeValue(
        item,
        itemSchemaForIndex(effectiveSchema),
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
      schemaDeclaresOpaqueLinkObject(effectiveSchema)
    ) {
      return { value, linkedStringCount: 0 };
    }
    let linkedStringCount = 0;
    const entries = Object.entries(value).map(([key, child]) => {
      const sanitized = sanitizeValue(
        child,
        childSchemaForKey(effectiveSchema, key),
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
