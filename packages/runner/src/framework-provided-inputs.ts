import type { JSONSchema } from "@commonfabric/api";
import { isRecord } from "@commonfabric/utils/types";

/** Remove runner-owned inputs from the schema exposed to an external caller. */
export function stripFrameworkProvidedPaths(
  schema: JSONSchema,
  paths: readonly (readonly string[])[],
): JSONSchema {
  let result = schema;
  for (const path of paths) {
    result = stripFrameworkProvidedPath(result, path);
  }
  return result;
}

function stripFrameworkProvidedPath(
  schema: JSONSchema,
  path: readonly string[],
): JSONSchema {
  if (!isRecord(schema) || path.length === 0) return schema;
  const [head, ...tail] = path;
  if (!head || !isRecord(schema.properties)) return schema;
  const existing = schema.properties[head] as JSONSchema | undefined;
  if (existing === undefined) return schema;

  const properties = { ...schema.properties };
  let removeFromRequired = tail.length === 0;
  if (tail.length === 0) {
    delete properties[head];
  } else {
    const strippedChild = stripFrameworkProvidedPath(existing, tail);
    if (isSystemOnlyObjectSchema(strippedChild)) {
      delete properties[head];
      removeFromRequired = true;
    } else {
      properties[head] = strippedChild;
      removeFromRequired = !hasRequiredAuthoredProperty(strippedChild);
    }
  }
  return {
    ...schema,
    properties,
    ...(Array.isArray(schema.required)
      ? {
        required: removeFromRequired
          ? schema.required.filter((key) => key !== head)
          : schema.required,
      }
      : {}),
  };
}

function isSystemOnlyObjectSchema(schema: JSONSchema): boolean {
  if (!isRecord(schema) || schema.type !== "object") return false;
  if (
    !isRecord(schema.properties) || Object.keys(schema.properties).length > 0
  ) {
    return false;
  }
  return Object.keys(schema).every((key) =>
    key === "type" || key === "properties" || key === "required"
  );
}

function hasRequiredAuthoredProperty(schema: JSONSchema): boolean {
  return isRecord(schema) && Array.isArray(schema.required) &&
    schema.required.length > 0;
}

/** Overwrite runner-owned inputs with a value derived from trusted identity. */
export function applyFrameworkProvidedInputs(
  args: Record<string, unknown>,
  paths: readonly (readonly string[])[],
  stableEntityId: string | undefined,
): Record<string, unknown> {
  if (paths.length === 0) return args;
  if (typeof stableEntityId !== "string" || stableEntityId.length === 0) {
    throw new Error(
      "Cannot provide FrameworkProvided factory inputs: tool instance has no stable entity id",
    );
  }
  const value = stableEntityId.replace(/[^A-Za-z0-9_-]/g, "-");
  let result = args;
  for (const path of paths) {
    result = setFrameworkProvidedPath(result, path, value);
  }
  return result;
}

function setFrameworkProvidedPath(
  input: Record<string, unknown>,
  path: readonly string[],
  value: string,
): Record<string, unknown> {
  const [head, ...tail] = path;
  if (!head) return input;
  if (tail.length === 0) return { ...input, [head]: value };
  const existing = input[head];
  const child = isRecord(existing) && !Array.isArray(existing) ? existing : {};
  return {
    ...input,
    [head]: setFrameworkProvidedPath(child, tail, value),
  };
}
