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
  // If schemas are identical, they're compatible
  if (JSON.stringify(schema1) === JSON.stringify(schema2)) {
    return true;
  }

  // For bare type definitions
  if (typeof schema1 === "object" && !schema1.type && !schema2.type) {
    // Check each field in schema1 has a compatible type in schema2
    for (const [key, value] of Object.entries(schema1)) {
      const value2 = schema2[key];
      if (value2 && !checkSchemaCompatibility(value, value2)) {
        return false;
      }
    }
    return true;
  }

  // Handle simple type definitions
  if (typeof schema1.type === "string" && typeof schema2.type === "string") {
    return schema1.type === schema2.type;
  }

  // Handle array types
  if (schema1.type === "array" && schema2.type === "array") {
    if (!schema1.items || !schema2.items) return true;
    return checkSchemaCompatibility(schema1.items, schema2.items);
  }

  // Handle object types with properties
  if (schema1.type === "object" && schema2.type === "object") {
    if (!schema1.properties || !schema2.properties) return true;

    // Check each property in schema1 has a compatible definition in schema2
    for (const [key, prop1] of Object.entries(schema1.properties)) {
      const prop2 = schema2.properties[key];
      if (prop2 && !checkSchemaCompatibility(prop1, prop2)) {
        return false;
      }
    }
    return true;
  }

  // Handle union types
  if (Array.isArray(schema1.type) && Array.isArray(schema2.type)) {
    return schema1.type.every((type: any) => schema2.type.includes(type));
  }

  // Default to basic equality for other cases
  return JSON.stringify(schema1) === JSON.stringify(schema2);
}
