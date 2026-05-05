import { isInstance } from "@commonfabric/utils/types";
import type { FabricValue } from "./fabric-value.ts";
import type { ReconstructionContext } from "./fabric-value.ts";
import {
  jsonFromValueLegacy,
  seemsLikeJsonEncodedFabricValueLegacy,
  valueFromJsonLegacy,
} from "./json-encoding-legacy.ts";
import {
  jsonFromValueModern,
  seemsLikeJsonEncodedFabricValueModern,
  valueFromJsonModern,
} from "./json-encoding-modern.ts";

// ---------------------------------------------------------------------------
// Unified JSON encoding flag and dispatch configuration
// ---------------------------------------------------------------------------

/**
 * Module-level flag for unified JSON encoding, set by the `Runtime`
 * constructor via `setJsonEncodingConfig()`. When enabled, the public API
 * symbols dispatch to the `JsonEncodingContext` codec instead of plain
 * JSON.stringify / JSON.parse.
 */
let jsonEncodingEnabled = true;

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
 * Restores unified JSON encoding mode to its default (enabled). Called by
 * `Runtime.dispose()` to avoid leaking flags between runtime instances or
 * test runs.
 */
export function resetJsonEncodingConfig(): void {
  jsonEncodingEnabled = true;
}

// ---------------------------------------------------------------------------
// Flag-dispatched public API
// ---------------------------------------------------------------------------

/**
 * Encodes a fabric value to a JSON string. When unified JSON encoding is ON,
 * uses the modern JSON-based format. When OFF, equivalent to
 * `JSON.stringify(value)`.
 */
export function jsonFromValue(value: FabricValue): string {
  if (jsonEncodingEnabled) {
    return jsonFromValueModern(value);
  } else {
    return jsonFromValueLegacy(value);
  }
}

/**
 * Decodes a JSON string back into a fabric value which is expected to be a
 * plain object. Throws if it turns out to be something else.
 */
export function plainObjectFromJson<T extends object = object>(
  json: string,
  runtime?: ReconstructionContext,
): T {
  const result = valueFromJson(json, runtime);

  if ((result === null) || (typeof result !== "object")) {
    throw new Error("plainObjectFromJson: Decoded to non-object");
  } else if (Array.isArray(result)) {
    throw new Error(
      "plainObjectFromJson: Decoded to array (not a plain object)",
    );
  } else if (isInstance(result)) {
    throw new Error(
      "plainObjectFromJson: Decoded to instance (not a plain object)",
    );
  }

  return result as T;
}

/**
 * Indicates if the given text has a "first-blush" appearance as valid encoded
 * JSON as defined by this module.
 */
export function seemsLikeJsonEncodedFabricValue(value: string): boolean {
  if (jsonEncodingEnabled) {
    return seemsLikeJsonEncodedFabricValueModern(value);
  } else {
    return seemsLikeJsonEncodedFabricValueLegacy(value);
  }
}

/**
 * Decodes a JSON string back into a fabric value. When unified JSON encoding is
 * ON, uses the modern JSON-based format. When OFF, equivalent to
 * `JSON.parse(json)`. The `runtime` argument is only consulted when the flag
 * is ON; if omitted, the shared `EMPTY_RECONSTRUCTION_CONTEXT` is substituted,
 * which throws if any cell reconstruction is needed.
 */
export function valueFromJson(
  json: string,
  runtime?: ReconstructionContext | undefined,
): FabricValue {
  if (jsonEncodingEnabled) {
    return valueFromJsonModern(json, runtime);
  } else {
    return valueFromJsonLegacy(json);
  }
}
