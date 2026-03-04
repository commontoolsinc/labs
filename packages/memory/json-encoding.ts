import type { StorableValue } from "./interface.ts";
import type {
  ReconstructionContext,
  StorableClass,
  StorableInstance,
} from "./storable-protocol.ts";
import type { SerializationContext } from "./serialization-context.ts";
import type {
  JsonWireValue,
  SerializedForm,
} from "./json-serialization-context.ts";
import type { ByteTagCodec } from "./serialization.ts";
import { ExplicitTagStorable } from "./explicit-tag-storable.ts";
import { deserialize, serialize } from "./serialization.ts";
import {
  StorableError,
  StorableMap,
  StorableRegExp,
  StorableSet,
  StorableUint8Array,
} from "./storable-native-instances.ts";
import { TAGS } from "./type-tags.ts";

/**
 * JSON encoding context implementing the `/<Type>@<Version>` wire format
 * from the formal spec (Section 5).
 *
 * Implements two interfaces:
 * - `SerializationContext<string>` -- the public boundary interface. `encode()`
 *   does the full pipeline (serialize + stringify); `decode()` does parse +
 *   legacy escaping + deserialize.
 * - `ByteTagCodec<JsonWireValue>` -- the internal interface for tree-walking.
 *   `wrapTag()`/`unwrapTag()` handle the `/<tag>` wire format;
 *   `finalize()`/`parse()` convert to/from bytes.
 */
export class JsonEncodingContext
  implements SerializationContext<string>, ByteTagCodec<JsonWireValue> {
  /** Tag -> class registry for known types. */
  private readonly registry = new Map<
    string,
    StorableClass<StorableInstance>
  >();

  /** Whether failed reconstructions produce `ProblematicStorable` instead of
   *  throwing. */
  readonly lenient: boolean;

  constructor(options?: { lenient?: boolean }) {
    this.lenient = options?.lenient ?? false;

    // Register native wrapper classes for deserialization. Each wrapper's
    // static [RECONSTRUCT] method is used by the class registry fallback
    // path in deserialize(). This replaces the old ErrorHandler approach.
    this.registry.set(TAGS.Error, StorableError);
    this.registry.set(TAGS.Map, StorableMap);
    this.registry.set(TAGS.Set, StorableSet);
    // Note: TAGS.EpochNsec and TAGS.EpochDays are NOT registered here --
    // they have dedicated TypeHandlers (EpochNsecHandler, EpochDaysHandler)
    // that handle both serialization and deserialization directly.
    // Note: TAGS.BigInt is NOT registered here -- bigint is a primitive in
    // StorableDatum and is handled by a TypeHandler (like UndefinedHandler),
    // not a StorableInstance wrapper.
    this.registry.set(TAGS.Bytes, StorableUint8Array);
    this.registry.set(TAGS.RegExp, StorableRegExp);
  }

  // -------------------------------------------------------------------------
  // SerializationContext<string> -- public boundary interface
  // -------------------------------------------------------------------------

  /**
   * Encode a storable value to a JSON string. Serializes rich types into
   * the `/<Type>@<Version>` tagged wire format, then stringifies.
   */
  encode(value: StorableValue): string {
    return JSON.stringify(serialize(value, this));
  }

  /**
   * Decode a JSON string back into a storable value. Parses the string,
   * escapes legacy `/`-prefixed markers, then deserializes tagged forms
   * back into rich runtime types.
   */
  decode(data: string, runtime: ReconstructionContext): StorableValue {
    const parsed = JSON.parse(data) as StorableValue;
    return deserialize(
      this.escapeUnknownSlashKeys(parsed) as unknown as SerializedForm,
      this,
      runtime,
    );
  }

  // -------------------------------------------------------------------------
  // TagCodec<JsonWireValue> -- internal tag wrapping/unwrapping
  // -------------------------------------------------------------------------

  /** Get the wire format tag for a storable instance's type. */
  getTagFor(value: StorableInstance): string {
    if (value instanceof ExplicitTagStorable) {
      return value.typeTag;
    }
    // Check for typeTag property (used by native-wrapping StorableInstance classes).
    const typeTag = (value as { typeTag?: unknown }).typeTag;
    if (typeof typeTag === "string") {
      return typeTag;
    }
    // Future rounds will add Cell/Stream/etc. here.
    throw new Error(
      `JsonEncodingContext: no tag registered for value: ${value}`,
    );
  }

  /** Get the class that can reconstruct instances for a given tag. */
  getClassFor(
    tag: string,
  ): StorableClass<StorableInstance> | undefined {
    return this.registry.get(tag);
  }

  /**
   * Wrap a tag and state into the `/<tag>` wire format. Prepends `/` to the
   * tag to produce the JSON key. See Section 5.2 of the formal spec.
   */
  wrapTag(tag: string, state: SerializedForm): SerializedForm {
    return { [`/${tag}`]: state } as SerializedForm;
  }

  /**
   * Unwrap a wire representation. Detects single-key objects with `/`-prefixed
   * keys. Returns `{ tag, state }` or `null` if not a tagged value.
   * See Section 5.4 of the formal spec.
   */
  unwrapTag(
    data: SerializedForm,
  ): { tag: string; state: SerializedForm } | null {
    if (
      data === null || typeof data !== "object" || Array.isArray(data)
    ) {
      return null;
    }

    const keys = Object.keys(data);
    if (keys.length !== 1) {
      return null;
    }

    const key = keys[0];
    if (!key.startsWith("/")) {
      return null;
    }

    const tag = key.slice(1);
    const state = (data as Record<string, SerializedForm>)[key];
    return { tag, state };
  }

  // -------------------------------------------------------------------------
  // ByteTagCodec methods (byte-level boundary)
  // -------------------------------------------------------------------------

  /** Convert a JsonWireValue tree to UTF-8-encoded JSON bytes. */
  finalize(data: SerializedForm): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(data));
  }

  /** Parse UTF-8-encoded JSON bytes back into a JsonWireValue tree. */
  parse(bytes: Uint8Array): SerializedForm {
    return JSON.parse(new TextDecoder().decode(bytes)) as SerializedForm;
  }

  // -------------------------------------------------------------------------
  // Legacy marker escaping (private)
  //
  // Sigil links `{ "/": ... }` and entity IDs `{ "/": "string" }` use a
  // `/`-prefixed single key that collides with the `/<Type>@<Version>` wire
  // format. On the write path, `serialize()` handles this correctly via
  // `/object` escaping. On the read path, legacy data (written before the
  // flag was enabled) lacks `/object` wrapping, so `deserialize()` would
  // misinterpret bare `{ "/": ... }` as a tagged value with empty tag.
  //
  // `escapeUnknownSlashKeys` walks the parsed JSON and wraps any unknown
  // `/`-prefixed single-key objects in `/object` so `deserialize()` handles
  // them the same way as newly-written data.
  // -------------------------------------------------------------------------

  /**
   * Walk a parsed JSON tree and wrap any `/`-prefixed single-key objects
   * whose tag is not recognized by the serialization engine. This handles
   * legacy sigil links (`{ "/": ... }`) and entity IDs that were stored
   * before the flag was enabled. Known tags are left for `deserialize()`.
   *
   * For known tags, recurses into the state value to handle nested legacy
   * markers. For structural tags (`/object`, `/quote`), recursion is
   * skipped because their inner values are already correctly formed.
   */
  private escapeUnknownSlashKeys(data: StorableValue): StorableValue {
    if (data === null || data === undefined || typeof data !== "object") {
      return data;
    }

    if (Array.isArray(data)) {
      let changed = false;
      const result = data.map((item) => {
        const processed = this.escapeUnknownSlashKeys(item);
        if (processed !== item) changed = true;
        return processed;
      });
      return changed ? result : data;
    }

    const obj = data as Record<string, StorableValue>;
    const keys = Object.keys(obj);

    if (keys.length === 1 && keys[0].startsWith("/")) {
      const tag = keys[0].slice(1); // strip leading "/"

      // Structural tags: /object and /quote wrap values that are already
      // in the correct wire format. Do not recurse into them.
      if (tag === TAGS.object || tag === TAGS.quote) {
        return data;
      }

      if (KNOWN_TAGS.has(tag)) {
        // Known type tag (e.g., /Error@1, /BigInt@1) -- recurse into the
        // state value to handle nested legacy markers, but leave the tag
        // wrapper intact for deserialize().
        const innerProcessed = this.escapeUnknownSlashKeys(obj[keys[0]]);
        if (innerProcessed !== obj[keys[0]]) {
          return { [keys[0]]: innerProcessed } as StorableValue;
        }
        return data;
      }

      // Unknown tag (e.g., bare "/" key from a legacy sigil link). Wrap
      // in /object so deserialize() treats the inner object's keys
      // literally. Recurse into the inner value first for nested legacy.
      const innerProcessed = this.escapeUnknownSlashKeys(obj[keys[0]]);
      return {
        [`/${TAGS.object}`]: { [keys[0]]: innerProcessed },
      } as StorableValue;
    }

    // Multi-key object -- recurse into all values.
    let changed = false;
    const result: Record<string, StorableValue> = {};
    for (const key of keys) {
      const processed = this.escapeUnknownSlashKeys(obj[key]);
      result[key] = processed;
      if (processed !== obj[key]) changed = true;
    }
    return changed ? result as StorableValue : data;
  }
}

/** Set of all known serialization tags (without the `/` prefix). */
const KNOWN_TAGS: ReadonlySet<string> = new Set(Object.values(TAGS));
