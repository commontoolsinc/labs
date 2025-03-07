import type { JSONSchema } from "@commontools/builder";
import { addSchema, getSchema, getSchemaId } from "./schema-map.ts";
import {
  createItemsKnownToStorageSet,
  loadFromBlobby,
  saveToBlobby,
} from "./blobby-storage.ts";

// Track schemas known to storage to avoid redundant saves
const schemasKnownToStorage = createItemsKnownToStorageSet();

/**
 * Synchronizes a schema with the Blobby server.
 * Given an ID, tries to load the schema from the server.
 *
 * @param id The schema ID to sync/load
 * @returns Promise resolving to true if successfully loaded or already exists locally
 */
export async function syncSchemaBlobby(id: string): Promise<boolean> {
  // If we already have this schema locally, we're done
  if (getSchema(id)) {
    return true;
  }

  // Try to load the schema from Blobby
  const response = await loadFromBlobby<{
    schema: JSONSchema;
    rootSchema?: string;
  }>("schema", id);

  if (!response) return false;

  const { schema, rootSchema: rootSchemaId } = response;

  // If the response includes a rootSchema reference, load that too
  let rootSchemaObj: JSONSchema | undefined;
  if (rootSchemaId) {
    // Try to get the root schema locally first
    rootSchemaObj = getSchema(rootSchemaId)?.schema;

    // If not available locally, try to load it from Blobby
    if (!rootSchemaObj) {
      const success = await syncSchemaBlobby(rootSchemaId);
      if (success) {
        rootSchemaObj = getSchema(rootSchemaId)?.schema;
      }
    }
  }

  // Add the schema locally
  const schemaId = addSchema(schema, rootSchemaObj);
  if (id !== schemaId) {
    console.warn(`Schema ID mismatch: expected ${id}, got ${schemaId}`);
  }

  schemasKnownToStorage.add(schemaId);
  return true;
}

/**
 * Saves a schema to the Blobby server.
 * Takes schema objects and generates the ID.
 *
 * @param schema The JSON schema to save
 * @param rootSchema Optional root schema if different from schema
 * @returns Promise resolving to the generated schema ID if save was successful
 */
export async function saveSchema(
  schema: JSONSchema,
  rootSchema?: JSONSchema,
): Promise<string | null> {
  // Generate ID for the schema (or get existing if already registered)
  const schemaId = addSchema(schema, rootSchema);

  // Load it from the map, this normalizes the rootSchema, in particular it sets
  // it to undefined if it's the same as the schema
  ({ schema, rootSchema } = getSchema(schemaId)!);

  // If already saved to Blobby, just return the ID
  if (schemasKnownToStorage.has(schemaId)) return schemaId;

  // Mark schema as known to storage
  schemasKnownToStorage.add(schemaId);

  // Get rootSchema ID if available
  const rootSchemaId = rootSchema ? getSchemaId(rootSchema) : undefined;

  // Prepare data for saving
  const data: { schema: JSONSchema; rootSchema?: string } = {
    schema,
    ...(rootSchemaId ? { rootSchema: rootSchemaId } : {}),
  };

  const schemaPromise = saveToBlobby("schema", schemaId, data);
  const rootSchemaPromise = rootSchema
    ? saveSchema(rootSchema)
    : Promise.resolve(true);

  // Run saves in parallel
  const success = (await Promise.all([schemaPromise, rootSchemaPromise]))
    .every((s) => s);

  return success ? schemaId : null;
}
