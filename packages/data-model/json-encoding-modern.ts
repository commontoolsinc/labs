/**
 * Modern JSON encoding system.
 */

import type { FabricValue } from "./fabric-value.ts";
import type { ReconstructionContext } from "./fabric-value.ts";
import { JsonEncodingContext } from "./json-encoding-context.ts";

/** Shared JSON encoding context. */
const jsonEncodingContext = new JsonEncodingContext();

/**
 * Encodes a fabric value to a JSON string. When unified JSON encoding is ON,
 * uses the modern JSON-based format. When OFF, equivalent to
 * `JSON.stringify(value)`.
 */
export function jsonFromValueModern(value: FabricValue): string {
  return jsonEncodingContext.encode(value);
}

/**
 * Decodes a JSON string back into a fabric value. When unified JSON encoding is
 * ON, uses the modern JSON-based format. When OFF, equivalent to
 * `JSON.parse(json)`.
 */
export function valueFromJsonModern(
  json: string,
  runtime: ReconstructionContext,
): FabricValue {
  return jsonEncodingContext.decode(json, runtime);
}
