/**
 * Legacy JSON encoding system.
 */

import type { FabricValue } from "./fabric-value.ts";

/**
 * Encodes a fabric value to a JSON string, using the legacy (plain JSON)
 * encoding.
 */
export function jsonFromValueLegacy(value: FabricValue): string {
  try {
    const result = JSON.stringify(value);
    if (result !== undefined) {
      return result;
    }
  } catch {
    // Ignore. Fall through to more apt `throw` immediately below.
  }

  throw new Error("jsonFromValueLegacy: Cannot stringify given value.");
}

/**
 * Indicates if the given text has a "first-blush" appearance as valid encoded
 * JSON as defined by this module.
 */
export function seemsLikeJsonEncodedFabricValueLegacy(value: string): boolean {
  switch (value) {
    case "false":
    case "true":
    case "null": {
      return true;
    }
  }

  switch (value[0]) {
    case '"':
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
 * Decodes a legacy-format (plain) JSON string back into a fabric value.
 */
export function valueFromJsonLegacy(json: string): FabricValue {
  return JSON.parse(json);
}
