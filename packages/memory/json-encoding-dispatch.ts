import type { StorableValue } from "./interface.ts";
import type { ReconstructionContext } from "./storable-protocol.ts";
import { JsonEncodingContext } from "./json-encoding.ts";

// ---------------------------------------------------------------------------
// Module-level JSON encoding context (stateless -- created once, reused).
// ---------------------------------------------------------------------------

const jsonEncodingContext = new JsonEncodingContext();

// ---------------------------------------------------------------------------
// Flag-dispatched public API
//
// These two symbols are reassigned by `configureDispatch()` whenever the
// unified JSON encoding flag changes. When OFF (default), both are plain
// JSON.stringify / JSON.parse. When ON, they route through the
// `JsonEncodingContext` codec which handles serialization, legacy marker
// escaping, and deserialization internally.
// ---------------------------------------------------------------------------

/**
 * Encode a storable value to a JSON string. When unified JSON encoding is
 * ON, serializes rich types (bigint, undefined, Map, etc.) into the
 * `/<Type>@<Version>` tagged wire format and stringifies. When OFF,
 * equivalent to `JSON.stringify(value)`.
 */
export let jsonFromValue: (value: StorableValue) => string;

/**
 * Decode a JSON string back into a storable value. When unified JSON
 * encoding is ON, parses the string, escapes legacy `/`-prefixed markers,
 * and deserializes tagged forms back into rich runtime types. When OFF,
 * equivalent to `JSON.parse(json)`.
 */
export let valueFromJson: (
  json: string,
  runtime: ReconstructionContext,
) => StorableValue;

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
 * Reassign the public API symbols based on the current value of
 * `jsonEncodingEnabled`. Called at module load and whenever the flag
 * changes.
 */
function configureDispatch(): void {
  if (jsonEncodingEnabled) {
    // ----- Unified JSON encoding implementations -----

    jsonFromValue = (value: StorableValue): string => {
      return jsonEncodingContext.encode(value);
    };

    valueFromJson = (
      json: string,
      runtime: ReconstructionContext,
    ): StorableValue => {
      return jsonEncodingContext.decode(json, runtime);
    };
  } else {
    // ----- Passthrough (flag OFF) -----

    jsonFromValue = (value: StorableValue): string => {
      return JSON.stringify(value);
    };

    valueFromJson = (
      json: string,
      _runtime: ReconstructionContext,
    ): StorableValue => {
      return JSON.parse(json) as StorableValue;
    };
  }
}

/**
 * Activates or deactivates unified JSON encoding mode. Called by the
 * `Runtime` constructor to propagate
 * `ExperimentalOptions.unifiedJsonEncoding` into the memory layer.
 */
export function setJsonEncodingConfig(enabled: boolean): void {
  jsonEncodingEnabled = enabled;
  configureDispatch();
}

/**
 * Restores unified JSON encoding mode to its default (disabled). Called by
 * `Runtime.dispose()` to avoid leaking flags between runtime instances or
 * test runs.
 */
export function resetJsonEncodingConfig(): void {
  jsonEncodingEnabled = false;
  configureDispatch();
}

// ---------------------------------------------------------------------------
// Initialize dispatch to passthrough mode at module load.
// ---------------------------------------------------------------------------

configureDispatch();
