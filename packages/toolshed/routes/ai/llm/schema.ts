const OMIT_SCHEMA = Symbol("omit-schema");

function isObjectRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSchemaNode(schema: unknown): unknown {
  if (schema === true || schema === false) return schema;
  if (Array.isArray(schema)) {
    return schema
      .map((item) => normalizeSchemaNode(item))
      .filter((item) => item !== OMIT_SCHEMA);
  }
  if (!isObjectRecord(schema)) return schema;
  if (schema.type === "undefined") return OMIT_SCHEMA;

  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (
      key === "type" || key === "anyOf" || key === "properties" ||
      key === "required"
    ) {
      continue;
    }
    const normalized = normalizeSchemaNode(value);
    if (normalized !== OMIT_SCHEMA) {
      out[key] = normalized;
    }
  }

  const typeValue = schema.type;
  if (Array.isArray(typeValue)) {
    const filteredTypes = typeValue.filter((item) => item !== "undefined");
    if (filteredTypes.length === 1) {
      out.type = filteredTypes[0];
    } else if (filteredTypes.length > 1) {
      out.type = filteredTypes;
    }
  } else if (typeValue !== undefined && typeValue !== "undefined") {
    out.type = typeValue;
  }

  let droppedPropertyNames = new Set<string>();
  if (isObjectRecord(schema.properties)) {
    const properties: Record<string, unknown> = {};
    droppedPropertyNames = new Set<string>();
    for (const [key, value] of Object.entries(schema.properties)) {
      const normalized = normalizeSchemaNode(value);
      if (normalized === OMIT_SCHEMA) {
        droppedPropertyNames.add(key);
        continue;
      }
      properties[key] = normalized;
    }
    out.properties = properties;
  }

  if (Array.isArray(schema.required)) {
    const required = schema.required.filter((name) =>
      !droppedPropertyNames.has(String(name))
    );
    if (required.length > 0) {
      out.required = required;
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const anyOf = schema.anyOf
      .map((branch) => normalizeSchemaNode(branch))
      .filter((branch) => branch !== OMIT_SCHEMA);
    if (anyOf.length === 1 && isObjectRecord(anyOf[0])) {
      return {
        ...anyOf[0],
        ...out,
      };
    }
    if (anyOf.length > 1) {
      out.anyOf = anyOf;
    }
  }

  return out;
}

export function normalizeSchemaForProvider(schema: unknown): unknown {
  const normalized = normalizeSchemaNode(schema);
  return normalized === OMIT_SCHEMA ? {} : normalized;
}
