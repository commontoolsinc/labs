import type { StorableValue } from "./interface.ts";
import type { ReconstructionContext } from "./storable-protocol.ts";
import type { SerializedForm } from "./json-serialization-context.ts";
import { deserialize, serialize } from "./serialization.ts";
import { JsonEncodingContext } from "./json-encoding.ts";

// ---------------------------------------------------------------------------
// Module-level JSON encoding context (stateless -- created once, reused).
// ---------------------------------------------------------------------------

const jsonEncodingContext = new JsonEncodingContext();

// ---------------------------------------------------------------------------
// Flag-dispatched public API
//
// These two symbols are reassigned by `configureDispatch()` whenever the
// unified JSON encoding flag changes. When OFF (default), both are
// passthrough no-ops. When ON, they serialize/deserialize via the storable
// protocol and `JsonEncodingContext`.
// ---------------------------------------------------------------------------

/**
 * Encode a storable value for JSON storage. When unified JSON encoding is
 * ON, serializes rich types (bigint, undefined, Map, etc.) into the
 * `/<Type>@<Version>` tagged wire format. When OFF, returns the value
 * unchanged (passthrough).
 */
export let encodeJsonValue: (value: StorableValue) => StorableValue;

/**
 * Decode a storable value from JSON storage. When unified JSON encoding is
 * ON, deserializes `/<Type>@<Version>` tagged wire format back into rich
 * runtime types. When OFF, returns the data unchanged (passthrough).
 */
export let decodeJsonValue: (
  data: StorableValue,
  runtime: ReconstructionContext,
) => StorableValue;

// ---------------------------------------------------------------------------
// Unified JSON encoding flag and dispatch configuration
// ---------------------------------------------------------------------------

/**
 * Module-level flag for unified JSON encoding, set by the `Runtime`
 * constructor via `setJsonEncodingConfig()`. When enabled, the public API
 * symbols dispatch to serialize/deserialize implementations instead of
 * passthrough.
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

    encodeJsonValue = (value: StorableValue): StorableValue => {
      return serialize(
        value,
        jsonEncodingContext,
      ) as unknown as StorableValue;
    };

    decodeJsonValue = (
      data: StorableValue,
      runtime: ReconstructionContext,
    ): StorableValue => {
      return deserialize(
        data as unknown as SerializedForm,
        jsonEncodingContext,
        runtime,
      );
    };
  } else {
    // ----- Passthrough (flag OFF) -----

    encodeJsonValue = (value: StorableValue): StorableValue => {
      return value;
    };

    decodeJsonValue = (
      data: StorableValue,
      _runtime: ReconstructionContext,
    ): StorableValue => {
      return data;
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
