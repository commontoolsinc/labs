import { isRecord } from "@commontools/utils/types";
import type { EntityId } from "./doc-map.ts";

/**
 * Convert an entity ID to URI format with "of:" prefix
 */
export function toURI(value: unknown): string {
  if (isRecord(value)) {
    // Converts EntityId to JSON
    const parsed = JSON.parse(JSON.stringify(value)) as { "/": string };

    // Handle EntityId object
    if (typeof parsed["/"] === "string") return `of:${parsed["/"]}`;
  } else if (typeof value === "string") {
    // Already has prefix with colon
    if (value.includes(":")) return value;

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
  } else if (uri.startsWith("of:")) {
    return uri.slice(3);
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
