/**
 * Modern JSON encoding system.
 */

import type { FabricValue } from "./fabric-value.ts";
import type { ReconstructionContext } from "./fabric-value.ts";
import { EMPTY_RECONSTRUCTION_CONTEXT } from "./empty-reconstruction-context.ts";
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
 * Decodes a JSON string back into a fabric value. If `runtime` is `undefined`,
 * the shared `EMPTY_RECONSTRUCTION_CONTEXT` is used; that context throws on
 * any `getCell()` call, so callers who pass `undefined` are implicitly
 * asserting that the encoded value contains no cell references.
 */
export function valueFromJsonModern(
  json: string,
  runtime: ReconstructionContext | undefined,
): FabricValue {
  return jsonEncodingContext.decode(
    json,
    runtime ?? EMPTY_RECONSTRUCTION_CONTEXT,
  );
}
