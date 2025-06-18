import type { EntityId } from "./doc-map.ts";

/**
 * Convert an entity ID to URI format with "of:" prefix
 */
export function toURI(value: unknown): string {
  // Handle EntityId with toJSON method
  if (
    typeof value === "object" &&
    value !== null &&
    "toJSON" in value &&
    typeof value.toJSON === "function"
  ) {
    const json = value.toJSON();
    if (typeof json === "object" && json !== null && "/" in json) {
      return `of:${json["/"]}`;
    }
  }

  // Handle direct EntityId object
  if (typeof value === "object" && value !== null && "/" in value) {
    const id = (value as EntityId)["/"];
    if (typeof id === "string") {
      return `of:${id}`;
    }
  }

  // Handle string
  if (typeof value === "string") {
    // Already has prefix with colon
    if (value.includes(":")) {
      return value;
    }
    // Add "of:" prefix
    return `of:${value}`;
  }

  throw new Error(`Cannot convert value to URI: ${JSON.stringify(value)}`);
}

/**
 * Extract the hash from a URI by removing the "of:" prefix
 */
export function fromURI(uri: string): string {
  if (!uri.includes(":")) {
    return uri;
  }
  const [prefix, ...rest] = uri.split(":");
  if (prefix === "of") {
    return rest.join(":");
  } else throw new Error(`Invalid URI: ${uri}`);
}

/**
 * Normalize an entity ID to ensure consistent format for comparisons
 */
export function normalizeEntityId(id: EntityId | string): string {
  if (typeof id === "string") {
    return fromURI(id);
  }
  if (typeof id === "object" && id !== null && "/" in id) {
    return JSON.parse(JSON.stringify(id))["/"];
  }
  throw new Error(`Invalid entity ID: ${JSON.stringify(id)}`);
}
