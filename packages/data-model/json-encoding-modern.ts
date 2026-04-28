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
  switch (value) {
    case "false":
    case "true":
    case "null": {
      return true;
    }
  }

  switch (value[0]) {
    case "\"":
    case "[":
    case "{":
    case "-":
    case "0":
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
    case "6":
    case "7":
    case "8":
    case "9": {
      return true;
    }
  }

  return false;
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
