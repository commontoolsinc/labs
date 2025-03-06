import type { JSONSchema } from "@commontools/builder";
import {
  addSchema,
  getRootSchema,
  getRootSchemaId,
  getSchema,
  getSchemaId,
} from "./schema-map.ts";
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
    rootSchemaObj = getSchema(rootSchemaId);

    // If not available locally, try to load it from Blobby
    if (!rootSchemaObj) {
      const success = await syncSchemaBlobby(rootSchemaId);
      if (success) {
        rootSchemaObj = getSchema(rootSchemaId);
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
  let schemaId = getSchemaId(schema);

  if (!schemaId) {
    // Register the schema locally
    schemaId = addSchema(schema, rootSchema);
  }

  // If already saved to Blobby, just return the ID
  if (schemasKnownToStorage.has(schemaId)) {
    return schemaId;
  }

  // Mark schema as known to storage
  schemasKnownToStorage.add(schemaId);

  // Get rootSchema ID if available
  const rootSchemaId = getRootSchemaId(schemaId);

  // Prepare data for saving
  const data: { schema: JSONSchema; rootSchema?: string } = {
    schema,
  };

  if (rootSchemaId) {
    data.rootSchema = rootSchemaId;

    // If we have a root schema, make sure it's saved too
    const rootSchema = getRootSchema(schemaId);
    if (rootSchema) {
      await saveSchema(rootSchema);
    }
  }

  const success = await saveToBlobby("schema", schemaId, data);
  return success ? schemaId : null;
}
