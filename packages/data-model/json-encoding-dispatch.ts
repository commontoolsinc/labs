import type { FabricValue } from "./fabric-value.ts";
import type { ReconstructionContext } from "./fabric-protocol.ts";
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
// `JsonEncodingContext` codec which handles serialization and deserialization internally.
// ---------------------------------------------------------------------------

/**
 * Encode a fabric value to a JSON string. When unified JSON encoding is
 * ON, serializes rich types (bigint, undefined, Map, etc.) into the
 * `/<Type>@<Version>` tagged wire format and stringifies. When OFF,
 * equivalent to `JSON.stringify(value)`.
 */
export let jsonFromValue: (value: FabricValue) => string;

/**
 * Decode a JSON string back into a fabric value. When unified JSON
 * encoding is ON, parses the string and deserializes tagged forms back
 * into rich runtime types. When OFF,
 * equivalent to `JSON.parse(json)`.
 */
export let valueFromJson: (
  json: string,
  runtime: ReconstructionContext,
) => FabricValue;

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

    jsonFromValue = (value: FabricValue): string => {
      return jsonEncodingContext.encode(value);
    };

    valueFromJson = (
      json: string,
      runtime: ReconstructionContext,
    ): FabricValue => {
      return jsonEncodingContext.decode(json, runtime);
    };
  } else {
    // ----- Passthrough (flag OFF) -----

    jsonFromValue = (value: FabricValue): string => {
      const result = JSON.stringify(value);
      if (result === undefined) {
        throw new Error(
          "jsonFromValue: cannot stringify undefined (flag OFF)",
        );
      }
      return result;
    };

    valueFromJson = (
      json: string,
      _runtime: ReconstructionContext,
    ): FabricValue => {
      return JSON.parse(json) as FabricValue;
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
