import type { JSONSchema } from "@commontools/builder";
import { refer } from "merkle-reference";

const schemaById = new Map<
  string,
  { schema: JSONSchema; rootSchema?: JSONSchema }
>();
const idBySchema = new WeakMap<JSONSchema, string>();

/**
 * Adds a schema to the schema registry.
 * Generates an ID as a merkle reference from the schema itself.
 *
 * @param schema The JSON schema to add
 * @param rootSchema Optional root schema if different from schema
 * @returns The generated schema ID
 */
export function addSchema(
  schema: JSONSchema,
  rootSchema?: JSONSchema,
): string {
  // If we've already added this schema object, return its existing ID
  if (idBySchema.has(schema)) return idBySchema.get(schema)!;

  // If the schema is the same as the root schema, don't store it
  if (
    schema === rootSchema ||
    JSON.stringify(schema) === JSON.stringify(rootSchema)
  ) {
    rootSchema = undefined;
  }

  // Generate a merkle reference ID from the schema itself
  const id = refer({ schema, ...(rootSchema ? { rootSchema } : {}) })
    .toString();

  // Store the schema
  schemaById.set(id, { schema, rootSchema });
  idBySchema.set(schema, id);

  // If a root schema is provided, store it and get/generate its ID
  if (rootSchema) addSchema(rootSchema, undefined);

  return id;
}

/**
 * Gets a schema by its ID
 * @param id The schema ID
 * @returns The schema and root schemaor undefined if not found
 */
export function getSchema(
  id: string,
): { schema: JSONSchema; rootSchema?: JSONSchema } | undefined {
  return schemaById.get(id);
}

/**
 * Gets the ID for a schema object
 * @param schema The schema object
 * @returns The schema ID or undefined if not registered
 */
export function getSchemaId(schema: JSONSchema): string | undefined {
  return idBySchema.get(schema);
}
