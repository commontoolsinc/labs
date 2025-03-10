async function createCacheKey(schema1: any, schema2: any): Promise<string> {
  // Create deterministic cache key from both schemas
  const combined = JSON.stringify([schema1, schema2].sort());
  const encoder = new TextEncoder();
  const data = encoder.encode(combined);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface SchemaCache {
  compatibilityResults: Map<string, boolean>;
}

const cache: SchemaCache = {
  compatibilityResults: new Map(),
};

export async function areSchemaCompatible(
  schema1: any,
  schema2: any,
): Promise<boolean> {
  const cacheKey = await createCacheKey(schema1, schema2);

  // Check cache first
  if (cache.compatibilityResults.has(cacheKey)) {
    return cache.compatibilityResults.get(cacheKey)!;
  }

  // Simple compatibility check - could be enhanced further
  const isCompatible = checkSchemaCompatibility(schema1, schema2);

  // Cache result
  cache.compatibilityResults.set(cacheKey, isCompatible);

  return isCompatible;
}

function checkSchemaCompatibility(schema1: any, schema2: any): boolean {
  // Handle array types
  if (schema1.type === "array" && schema2.type === "array") {
    if (!schema1.items || !schema2.items) {
      return !schema1.items && !schema2.items;
    }
    return checkSchemaCompatibility(schema1.items, schema2.items);
  }

  // Handle object types with properties
  if (schema1.type === "object" && schema2.type === "object") {
    const props1 = schema1.properties || {};
    const props2 = schema2.properties || {};
    const keys1 = Object.keys(props1);

    // Schema1 must contain all and only the fields it needs
    return keys1.length === Object.keys(props2).length &&
      keys1.every((key) => {
        const prop2 = props2[key];
        return prop2 && checkSchemaCompatibility(props1[key], prop2);
      });
  }

  // Handle primitive types including unions
  if (schema1.type && schema2.type) {
    if (Array.isArray(schema1.type) || Array.isArray(schema2.type)) {
      const types1 = Array.isArray(schema1.type)
        ? schema1.type
        : [schema1.type];
      const types2 = Array.isArray(schema2.type)
        ? schema2.type
        : [schema2.type];
      return types1.length === types2.length &&
        types1.every((t: any) => types2.includes(t));
    }
    return schema1.type === schema2.type;
  }

  // For bare object schemas (no explicit type)
  const keys1 = Object.keys(schema1);
  const keys2 = Object.keys(schema2);

  // Must have exactly the same keys
  if (keys1.length !== keys2.length) {
    return false;
  }

  // Each key must have compatible values
  return keys1.every((key) => {
    if (!schema2[key]) return false;

    const value1 = schema1[key];
    const value2 = schema2[key];

    if (typeof value1 !== typeof value2) return false;

    if (typeof value1 === "object") {
      return checkSchemaCompatibility(value1, value2);
    }

    return value1 === value2;
  });
}
