import { isRecord } from "@commontools/utils/types";
import type { URI } from "./sigil-types.ts";

/**
 * Convert an entity ID to URI format with "of:" prefix
 */
export function toURI(value: unknown): URI {
  if (isRecord(value)) {
    // Converts EntityId to JSON
    const parsed = JSON.parse(JSON.stringify(value)) as { "/": string };

    // Handle EntityId object
    if (typeof parsed["/"] === "string") return `of:${parsed["/"]}`;
  } else if (typeof value === "string") {
    // Already has prefix with colon
    if (value.includes(":")) {
      // TODO(seefeld): Remove this once we want to support any URI, ideally
      // once there are no bare ids anymore
      if (!value.startsWith("of:")) {
        throw new Error(`Invalid URI: ${value}`);
      }
      return value as URI;
    }

    // Add "of:" prefix
    return `of:${value}`;
  }

  throw new Error(`Cannot convert value to URI: ${JSON.stringify(value)}`);
}

/**
 * Extract the hash from a URI by removing the "of:" prefix
 */
export function fromURI(uri: URI | string): string {
  if (!uri.includes(":")) {
    return uri;
  } else if (uri.startsWith("of:")) {
    return uri.slice(3);
  } else {
    // TODO(seefeld): Remove this once we want to support any URI
    throw new Error(`Invalid URI: ${uri}`);
  }
}

/**
 * Extract the JSON object from a data URI
 *
 * Data URIs are a way to embed JSON in a URI. They are a base64 encoded string
 * that is prefixed with "data:application/json". The string is then encoded in
 * base64.
 *
 * The data URI is a string that looks like this:
 *
 * data:application/json;charset=utf-8;base64,
 * @param uri - The data URI to extract the JSON from
 * @returns The JSON object
 * @throws If the URI is invalid or the JSON is invalid
 */
export function getJSONFromDataURI(uri: URI | string): any {
  if (!uri.startsWith("data:application/json")) {
    throw new Error(`Invalid URI: ${uri}`);
  }

  // Extract the data part after the comma
  const commaIndex = uri.indexOf(",");
  if (commaIndex === -1) {
    throw new Error(`Invalid data URI format: ${uri}`);
  }

  const header = uri.substring(0, commaIndex);
  const data = uri.substring(commaIndex + 1);

  // Parse the header to check for charset
  const headerParts = header.split(";").map((part) => part.trim());
  for (const part of headerParts) {
    if (part.startsWith("charset=")) {
      const charset = part.substring(8).toLowerCase();
      if (charset !== "utf-8" && charset !== "utf8") {
        throw new Error(
          `Unsupported charset: ${charset}. Only UTF-8 is supported.`,
        );
      }
    }
  }

  // Check if data is base64 encoded
  const isBase64 = headerParts.some((part) => part === "base64");

  const decodedData = isBase64 ? atob(data) : decodeURIComponent(data);

  return JSON.parse(decodedData);
}
