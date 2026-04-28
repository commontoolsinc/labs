/**
 * Modern JSON encoding system.
 */

import type { FabricValue } from "./fabric-value.ts";
import type { ReconstructionContext } from "./fabric-value.ts";
import { JsonEncodingContext } from "./json-encoding-context.ts";

/** Shared JSON encoding context. */
const jsonEncodingContext = new JsonEncodingContext();

/**
 * Encodes a fabric value to a JSON string.
 */
export function jsonFromValueModern(value: FabricValue): string {
  return jsonEncodingContext.encode(value);
}

/**
 * Indicates if the given text has a "first-blush" appearance as valid encoded
 * JSON as defined by this module.
 */
export function seemsLikeJsonEncodedFabricValueModern(value: string): boolean {
  return JsonEncodingContext.seemsLikeEncoded(value);
}

/**
 * Decodes a JSON string back into a fabric value.
 */
export function valueFromJsonModern(
  json: string,
  runtime: ReconstructionContext,
): FabricValue {
  return jsonEncodingContext.decode(json, runtime);
}
