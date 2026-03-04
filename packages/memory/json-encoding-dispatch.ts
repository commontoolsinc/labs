import type { StorableValue } from "./interface.ts";
import type { ReconstructionContext } from "./storable-protocol.ts";
import type { SerializedForm } from "./json-serialization-context.ts";
import { deserialize, serialize } from "./serialization.ts";
import { JsonEncodingContext } from "./json-encoding.ts";
import { TAGS } from "./type-tags.ts";

// ---------------------------------------------------------------------------
// Module-level JSON encoding context (stateless -- created once, reused).
// ---------------------------------------------------------------------------

const jsonEncodingContext = new JsonEncodingContext();

// ---------------------------------------------------------------------------
// Known serialization tags -- used to distinguish the new wire format from
// legacy `/`-prefixed single-key objects (sigil links, entity IDs).
// ---------------------------------------------------------------------------

/** Set of all known serialization tags (without the `/` prefix). */
const KNOWN_TAGS: ReadonlySet<string> = new Set(Object.values(TAGS));

// ---------------------------------------------------------------------------
// Legacy marker passthrough helper
//
// Sigil links `{ "/": ... }` and entity IDs `{ "/": "string" }` use a
// `/`-prefixed single key that collides with the `/<Type>@<Version>` wire
// format. On the write path, `serialize()` handles this correctly via
// `/object` escaping. On the read path, legacy data (written before the
// flag was enabled) lacks `/object` wrapping, so `deserialize()` would
// misinterpret bare `{ "/": ... }` as a tagged value with empty tag.
//
// `escapeUnknownSlashKeys` walks the parsed JSON and wraps any unknown
// `/`-prefixed single-key objects in `/object` so `deserialize()` processes
// them the same way as newly-written data.
// ---------------------------------------------------------------------------

/**
 * Walk a parsed JSON tree and wrap any `/`-prefixed single-key objects
 * whose tag is not recognized by the serialization engine. This handles
 * legacy sigil links (`{ "/": ... }`) and entity IDs that were stored
 * before the flag was enabled. Known tags are left for `deserialize()`.
 *
 * For known tags, recurses into the state value to handle nested legacy
 * markers. For structural tags (`/object`, `/quote`), recursion is skipped
 * because their inner values are already correctly formed.
 */
function escapeUnknownSlashKeys(data: StorableValue): StorableValue {
  if (data === null || data === undefined || typeof data !== "object") {
    return data;
  }

  if (Array.isArray(data)) {
    let changed = false;
    const result = data.map((item) => {
      const processed = escapeUnknownSlashKeys(item);
      if (processed !== item) changed = true;
      return processed;
    });
    return changed ? result : data;
  }

  const obj = data as Record<string, StorableValue>;
  const keys = Object.keys(obj);

  if (keys.length === 1 && keys[0].startsWith("/")) {
    const tag = keys[0].slice(1); // strip leading "/"

    // Structural tags: /object and /quote wrap values that are already in
    // the correct wire format. Do not recurse into them.
    if (tag === TAGS.object || tag === TAGS.quote) {
      return data;
    }

    if (KNOWN_TAGS.has(tag)) {
      // Known type tag (e.g., /Error@1, /BigInt@1) -- recurse into the
      // state value to handle nested legacy markers, but leave the tag
      // wrapper intact for deserialize().
      const innerProcessed = escapeUnknownSlashKeys(obj[keys[0]]);
      if (innerProcessed !== obj[keys[0]]) {
        return { [keys[0]]: innerProcessed } as StorableValue;
      }
      return data;
    }

    // Unknown tag (e.g., bare "/" key from a legacy sigil link). Wrap in
    // /object so deserialize() treats the inner object's keys literally.
    // Recurse into the inner value first to handle any nested legacy data.
    const innerProcessed = escapeUnknownSlashKeys(obj[keys[0]]);
    return {
      [`/${TAGS.object}`]: { [keys[0]]: innerProcessed },
    } as StorableValue;
  }

  // Multi-key object -- recurse into all values.
  let changed = false;
  const result: Record<string, StorableValue> = {};
  for (const key of keys) {
    const processed = escapeUnknownSlashKeys(obj[key]);
    result[key] = processed;
    if (processed !== obj[key]) changed = true;
  }
  return changed ? result as StorableValue : data;
}

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
        escapeUnknownSlashKeys(data) as unknown as SerializedForm,
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
