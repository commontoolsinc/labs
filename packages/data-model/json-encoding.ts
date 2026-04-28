import type { FabricValue } from "./fabric-value.ts";
import type { ReconstructionContext } from "./fabric-value.ts";
import { JsonEncodingContext } from "./json-encoding-modern.ts";

// ---------------------------------------------------------------------------
// Unified JSON encoding flag and dispatch configuration
// ---------------------------------------------------------------------------

/**
 * Module-level flag for unified JSON encoding, set by the `Runtime`
 * constructor via `setJsonEncodingConfig()`. When enabled, the public API
 * symbols dispatch to the `JsonEncodingContext` codec instead of plain
 * JSON.stringify / JSON.parse.
 */
let jsonEncodingEnabled = false;

/**
 * Activates or deactivates unified JSON encoding mode. Called by the
 * `Runtime` constructor to propagate
 * `ExperimentalOptions.unifiedJsonEncoding` into the memory layer.
 */
export function setJsonEncodingConfig(enabled?: boolean): void {
  if (enabled !== undefined) {
    jsonEncodingEnabled = enabled;
  }
}

/** Returns whether unified JSON encoding mode is currently enabled. */
export function getJsonEncodingConfig(): boolean {
  return jsonEncodingEnabled;
}

/**
 * Restores unified JSON encoding mode to its default (disabled). Called by
 * `Runtime.dispose()` to avoid leaking flags between runtime instances or
 * test runs.
 */
export function resetJsonEncodingConfig(): void {
  jsonEncodingEnabled = false;
}

// ---------------------------------------------------------------------------
// Flag-dispatched public API
// ---------------------------------------------------------------------------

const jsonEncodingContext = new JsonEncodingContext();

/**
 * Encodes a fabric value to a JSON string. When unified JSON encoding is ON,
 * uses the modern JSON-based format. When OFF, equivalent to
 * `JSON.stringify(value)`.
 */
export function jsonFromValue(value: FabricValue): string {
  if (jsonEncodingEnabled) {
    return jsonEncodingContext.encode(value);
  } else {
    try {
      const result = JSON.stringify(value);
      if (result !== undefined) {
        return result;
      }
    } catch {
      // Ignore. Fall through to more apt `throw` immediately below.
    }

    throw new Error("jsonFromValue (legacy): Cannot stringify given value.");
  }
}

/**
 * Decodes a JSON string back into a fabric value. When unified JSON encoding is
 * ON, uses the modern JSON-based format. When OFF, equivalent to
 * `JSON.parse(json)`.
 */
export function valueFromJson(
  json: string,
  runtime: ReconstructionContext,
): FabricValue {
  if (jsonEncodingEnabled) {
    return jsonEncodingContext.decode(json, runtime);
  } else {
    return JSON.parse(json);
  }
}
