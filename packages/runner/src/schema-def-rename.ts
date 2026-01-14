import { deepEqual } from "@commontools/utils/deep-equal";
import { isRecord } from "@commontools/utils/types";

type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
interface JsonObject {
  [key: string]: JsonValue;
}
interface JsonArray extends Array<JsonValue> {}

interface RenameMap {
  [oldName: string]: string;
}

/**
 * Renames $ref and $defs in a JSON Schema according to the provided mapping
 * @param schema - The JSON Schema object to process
 * @param renameMap - Map of old names to new names (e.g., { "OldDef": "NewDef" })
 * @returns A new schema object with renamed refs and defs
 */
export function renameSchemaRefs(
  schema: JsonValue,
  renameMap: RenameMap,
): JsonValue {
  if (schema === null || typeof schema !== "object") {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map((item) => renameSchemaRefs(item, renameMap));
  }

  const result: JsonObject = {};

  for (const [key, value] of Object.entries(schema)) {
    // Handle $ref renaming
    if (key === "$ref" && typeof value === "string") {
      result[key] = renameRef(value, renameMap);
    } // Handle $defs renaming (rename the keys in the $defs object)
    else if (
      key === "$defs" && typeof value === "object" && value !== null &&
      !Array.isArray(value)
    ) {
      result[key] = renameDefsObject(value as JsonObject, renameMap);
    } // Handle definitions (older JSON Schema versions)
    else if (
      key === "definitions" && typeof value === "object" && value !== null &&
      !Array.isArray(value)
    ) {
      result[key] = renameDefsObject(value as JsonObject, renameMap);
    } // Recursively process other values
    else {
      result[key] = renameSchemaRefs(value, renameMap);
    }
  }

  return result;
}

/**
 * Renames a $ref path according to the rename map
 */
function renameRef(ref: string, renameMap: RenameMap): string {
  // Handle different ref formats
  // #/$defs/TypeName or #/definitions/TypeName
  const match = ref.match(/^#\/((\$defs|definitions)\/)(.+)$/);

  if (match) {
    const [, prefix, , defName] = match;
    const newName = renameMap[defName] || defName;
    return `#/${prefix}${newName}`;
  }

  // Handle fragment-only refs like just the definition name
  if (renameMap[ref]) {
    return renameMap[ref];
  }

  return ref;
}

/**
 * Renames the keys in a $defs or definitions object
 */
function renameDefsObject(defs: JsonObject, renameMap: RenameMap): JsonObject {
  const result: JsonObject = {};

  for (const [oldName, value] of Object.entries(defs)) {
    const newName = renameMap[oldName] || oldName;
    // Recursively process the definition value
    result[newName] = renameSchemaRefs(value, renameMap);
  }

  return result;
}

export function buildRenameMap(
  schema: JsonValue,
  baseSchema: JsonValue,
): Record<string, string> | null {
  if (
    !isRecord(schema) || !isRecord(baseSchema) || !("$defs" in schema) ||
    !("$defs" in baseSchema)
  ) {
    return null;
  }
  if (schema.$defs && baseSchema.$defs) {
    const renameMap: Record<string, string> = {};
    for (const [defKey, defValue] of Object.entries(schema.$defs)) {
      if (
        isRecord(baseSchema.$defs) && (defKey in baseSchema.$defs) &&
        !deepEqual(baseSchema.$defs[defKey], defValue)
      ) {
        let counter = 0;
        while (`${defKey}_${counter}` in baseSchema.$defs) {
          counter++;
        }
        renameMap[defKey] = `${defKey}_${counter}`;
      }
      if (Object.keys(renameMap).length > 0) {
        return renameMap;
      }
    }
  }
  return null;
}
