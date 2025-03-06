import type { JSONSchema } from "@commontools/builder";
import { createRef } from "./doc-map.ts";

const schemaById = new Map<string, JSONSchema>();
const rootSchemaBySchemaId = new Map<string, JSONSchema>();
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

  // Store the schema
  schemaById.set(id, schema);
  idBySchema.set(schema, id);

  // If a root schema is provided, store it and get/generate its ID
  if (rootSchema && rootSchema !== schema) {
    rootSchemaBySchemaId.set(id, rootSchema);

    // Make sure the root schema is also registered
    if (!idBySchema.has(rootSchema)) {
      const rootId = createRef(rootSchema, "schema").toString();
      schemaById.set(rootId, rootSchema);
      idBySchema.set(rootSchema, rootId);
    }
  }

  return id;
}

/**
 * Gets a schema by its ID
 * @param id The schema ID
 * @returns The schema or undefined if not found
 */
export function getSchema(id: string): JSONSchema | undefined {
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
  return rootSchemaBySchemaId.get(id);
}

/**
 * Gets the root schema ID for a schema, if one was specified
 * @param id The schema ID
 * @returns The root schema ID or undefined if none was specified
 */
export function getRootSchemaId(id: string): string | undefined {
  const rootSchema = rootSchemaBySchemaId.get(id);
  return rootSchema ? idBySchema.get(rootSchema) : undefined;
}
