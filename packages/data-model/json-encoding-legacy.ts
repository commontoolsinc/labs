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
 * Decodes a legacy-format (plain) JSON string back into a fabric value.
 */
export function valueFromJsonLegacy(json: string): FabricValue {
  return JSON.parse(json);
}
