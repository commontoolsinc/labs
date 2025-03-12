import type { JSONSchema } from "@commontools/builder";
import { createRef } from "./doc-map.ts";

const schemaById = new Map<string, { schema: JSONSchema; rootSchema?: JSONSchema }>();
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

  // Generate a merkle reference ID from the schema itself
  const id = createRef(schema, "schema").toString();

  // If rootSchema is the same as schema, don't store it separately
  if (rootSchema === schema) rootSchema = undefined;

  // Store the schema
  schemaById.set(id, { schema, rootSchema });
  idBySchema.set(schema, id);

  // If a root schema is provided, make sure it's also registered
  if (rootSchema) {
    // Make sure the root schema is also registered
    if (!idBySchema.has(rootSchema)) {
      addSchema(rootSchema);
    }
  }

  return id;
}

/**
 * Gets a schema by its ID
 * @param id The schema ID
 * @returns The schema or undefined if not found
 */
export function getSchema(id: string): { schema: JSONSchema; rootSchema?: JSONSchema } | undefined {
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

/**
 * Gets the root schema for a schema, if one was specified
 * @param id The schema ID
 * @returns The root schema or undefined if none was specified
 */
export function getRootSchema(id: string): JSONSchema | undefined {
  const entry = schemaById.get(id);
  return entry?.rootSchema;
}

/**
 * Gets the root schema ID for a schema, if one was specified
 * @param id The schema ID
 * @returns The root schema ID or undefined if none was specified
 */
export function getRootSchemaId(id: string): string | undefined {
  const entry = schemaById.get(id);
  if (!entry?.rootSchema) return undefined;
  return getSchemaId(entry.rootSchema);
}