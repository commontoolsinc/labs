import type { StorableValue } from "./interface.ts";
import {
  RECONSTRUCT,
  type ReconstructionContext,
  type SerializationContext,
  type StorableClass,
  type StorableInstance,
} from "./storable-protocol.ts";
import { ExplicitTagStorable } from "./explicit-tag-storable.ts";
import { deepFreeze } from "./deep-freeze.ts";
import { UnknownStorable } from "./unknown-storable.ts";
import { ProblematicStorable } from "./problematic-storable.ts";
import {
  createDefaultRegistry,
  type JsonWireValue,
  type TypeHandlerCodec,
  type TypeHandlerRegistry,
} from "./json-type-handlers.ts";
import {
  StorableError,
  StorableMap,
  StorableRegExp,
  StorableSet,
  StorableUint8Array,
} from "./storable-native-instances.ts";
import { TAGS } from "./type-tags.ts";

/** Shared default handler registry, created once. */
const defaultRegistry: TypeHandlerRegistry = createDefaultRegistry();

/**
 * JSON encoding context implementing the `/<Type>@<Version>` wire format
 * from the formal spec (Section 5).
 *
 * Public interface: `SerializationContext<string>`
 * - `encode(value)` -- full pipeline: serialize + stringify
 * - `decode(data, runtime)` -- full pipeline: parse + legacy escape + deserialize
 *
 * All internal machinery (tag wrapping, tree walking, byte conversion) is
 * private. Type handlers receive a narrow `TypeHandlerCodec` view of `this`
 * during tree walking.
 */
export class JsonEncodingContext implements SerializationContext<string> {
  /** Tag -> class registry for known types. */
  private readonly registry = new Map<
    string,
    StorableClass<StorableInstance>
  >();

  /** Whether failed reconstructions produce `ProblematicStorable` instead of
   *  throwing. */
  readonly lenient: boolean;

  /** Narrow codec view for type handlers (avoids exposing private methods). */
  private readonly codec: TypeHandlerCodec;

  constructor(options?: { lenient?: boolean }) {
    this.lenient = options?.lenient ?? false;

    // Create a codec view that delegates to our private methods.
    this.codec = {
      wrapTag: (tag: string, state: JsonWireValue) => this.wrapTag(tag, state),
      getTagFor: (value: StorableInstance) => this.getTagFor(value),
    };

    // Register native wrapper classes for deserialization. Each wrapper's
    // static [RECONSTRUCT] method is used by the class registry fallback
    // path in deserialize().
    this.registry.set(TAGS.Error, StorableError);
    this.registry.set(TAGS.Map, StorableMap);
    this.registry.set(TAGS.Set, StorableSet);
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
    return JSON.stringify(this.serialize(value));
  }

  /**
   * Decode a JSON string back into a storable value. Parses the string,
   * escapes legacy `/`-prefixed markers, then deserializes tagged forms
   * back into rich runtime types.
   */
  decode(data: string, runtime: ReconstructionContext): StorableValue {
    const parsed = JSON.parse(data) as StorableValue;
    return this.deserialize(
      this.escapeUnknownSlashKeys(parsed) as unknown as JsonWireValue,
      runtime,
    );
  }

  // -------------------------------------------------------------------------
  // Byte-level boundary (public for now -- used by serializeToBytes tests)
  // -------------------------------------------------------------------------

  /**
   * Serialize a storable value to UTF-8 JSON bytes.
   */
  encodeToBytes(value: StorableValue): Uint8Array {
    return this.toBytes(this.serialize(value));
  }

  /**
   * Deserialize UTF-8 JSON bytes back into a storable value.
   */
  decodeFromBytes(
    bytes: Uint8Array,
    runtime: ReconstructionContext,
  ): StorableValue {
    const tree = this.fromBytes(bytes);
    return this.deserialize(
      this.escapeUnknownSlashKeys(tree) as unknown as JsonWireValue,
      runtime,
    );
  }

  // -------------------------------------------------------------------------
  // Tag wrapping/unwrapping (private)
  // -------------------------------------------------------------------------

  /** Get the wire format tag for a storable instance's type. */
  private getTagFor(value: StorableInstance): string {
    if (value instanceof ExplicitTagStorable) {
      return value.typeTag;
    }
    const typeTag = (value as { typeTag?: unknown }).typeTag;
    if (typeof typeTag === "string") {
      return typeTag;
    }
    throw new Error(
      `JsonEncodingContext: no tag registered for value: ${value}`,
    );
  }

  /** Get the class that can reconstruct instances for a given tag. */
  private getClassFor(
    tag: string,
  ): StorableClass<StorableInstance> | undefined {
    return this.registry.get(tag);
  }

  /**
   * Wrap a tag and state into the `/<tag>` wire format. Prepends `/` to the
   * tag to produce the JSON key. See Section 5.2 of the formal spec.
   */
  private wrapTag(tag: string, state: JsonWireValue): JsonWireValue {
    return { [`/${tag}`]: state } as JsonWireValue;
  }

  /**
   * Unwrap a wire representation. Detects single-key objects with `/`-prefixed
   * keys. Returns `{ tag, state }` or `null` if not a tagged value.
   * See Section 5.4 of the formal spec.
   */
  private unwrapTag(
    data: JsonWireValue,
  ): { tag: string; state: JsonWireValue } | null {
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
    const state = (data as Record<string, JsonWireValue>)[key];
    return { tag, state };
  }

  // -------------------------------------------------------------------------
  // Byte conversion (private)
  // -------------------------------------------------------------------------

  /** Convert a wire-format tree to UTF-8-encoded JSON bytes. */
  private toBytes(data: JsonWireValue): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(data));
  }

  /** Parse UTF-8-encoded JSON bytes back into a wire-format tree. */
  private fromBytes(bytes: Uint8Array): JsonWireValue {
    return JSON.parse(new TextDecoder().decode(bytes)) as JsonWireValue;
  }

  // -------------------------------------------------------------------------
  // Tree-walking serialization (private)
  //
  // Moved from serialization.ts. These methods walk the value tree,
  // dispatching to type handlers and applying structural escaping.
  // -------------------------------------------------------------------------

  /**
   * Serialize a storable value into wire format. Recursively processes nested
   * values. See Section 4.5 of the formal spec.
   */
  private serialize(
    value: StorableValue,
    _seen?: Set<object>,
    registry: TypeHandlerRegistry = defaultRegistry,
  ): JsonWireValue {
    // --- Try type handlers first ---
    const handler = registry.findSerializer(value);
    if (handler) {
      const seen = _seen ?? new Set<object>();

      if (value !== null && typeof value === "object") {
        if (seen.has(value as object)) {
          throw new Error("Circular reference detected during serialization");
        }
        seen.add(value as object);
      }

      const result = handler.serialize(
        value,
        this.codec,
        (v: StorableValue) => this.serialize(v, seen, registry),
      );

      if (value !== null && typeof value === "object") {
        seen.delete(value as object);
      }

      return result;
    }

    // --- Primitives ---
    if (
      value === null || typeof value === "boolean" ||
      typeof value === "number" || typeof value === "string"
    ) {
      return value as JsonWireValue;
    }

    // --- Arrays ---
    if (Array.isArray(value)) {
      const seen = _seen ?? new Set<object>();
      if (seen.has(value)) {
        throw new Error("Circular reference detected during serialization");
      }
      seen.add(value);

      const result: JsonWireValue[] = [];
      let i = 0;
      while (i < value.length) {
        if (!(i in value)) {
          let count = 0;
          while (i < value.length && !(i in value)) {
            count++;
            i++;
          }
          result.push(this.wrapTag(TAGS.hole, count));
        } else {
          result.push(
            this.serialize(value[i] as StorableValue, seen, registry),
          );
          i++;
        }
      }

      seen.delete(value);
      return result as JsonWireValue;
    }

    // --- Plain objects ---
    const seen = _seen ?? new Set<object>();
    if (seen.has(value as object)) {
      throw new Error("Circular reference detected during serialization");
    }
    seen.add(value as object);

    const result: Record<string, JsonWireValue> = {};
    for (
      const [key, val] of Object.entries(
        value as Record<string, StorableValue>,
      )
    ) {
      result[key] = this.serialize(val, seen, registry);
    }

    seen.delete(value as object);

    // Apply `TAGS.object` escaping per Section 5.6.
    const keys = Object.keys(result);
    if (keys.length === 1 && keys[0].startsWith("/")) {
      return this.wrapTag(TAGS.object, result) as JsonWireValue;
    }

    return result as JsonWireValue;
  }

  // -------------------------------------------------------------------------
  // Tree-walking deserialization (private)
  // -------------------------------------------------------------------------

  /**
   * Deserialize a wire-format value back into rich runtime types.
   * See Section 4.5 of the formal spec.
   */
  private deserialize(
    data: JsonWireValue,
    runtime: ReconstructionContext,
    registry: TypeHandlerRegistry = defaultRegistry,
  ): StorableValue {
    const decoded = this.unwrapTag(data);
    if (decoded !== null) {
      const { tag, state } = decoded;

      // `TAGS.object` unwrapping (Section 5.6).
      if (tag === TAGS.object) {
        const inner = state as Record<string, JsonWireValue>;
        const result: Record<string, StorableValue> = {};
        for (const [key, val] of Object.entries(inner)) {
          result[key] = this.deserialize(val, runtime, registry);
        }
        return Object.freeze(result);
      }

      // `TAGS.quote` literal handling (Section 5.6).
      if (tag === TAGS.quote) {
        return deepFreeze(state) as StorableValue;
      }

      // --- Type handler dispatch ---
      const handler = registry.getDeserializer(tag);
      if (handler) {
        if (this.lenient) {
          try {
            return handler.deserialize(
              state,
              runtime,
              (v: JsonWireValue) => this.deserialize(v, runtime, registry),
            );
          } catch (e: unknown) {
            return new ProblematicStorable(
              tag,
              state as unknown as StorableValue,
              e instanceof Error ? e.message : String(e),
            ) as unknown as StorableValue;
          }
        }
        return handler.deserialize(
          state,
          runtime,
          (v: JsonWireValue) => this.deserialize(v, runtime, registry),
        );
      }

      // --- Class registry fallback ---
      const cls = this.getClassFor(tag);
      const deserializedState = this.deserialize(state, runtime, registry);

      if (cls) {
        if (this.lenient) {
          try {
            return cls[RECONSTRUCT](
              deserializedState,
              runtime,
            ) as unknown as StorableValue;
          } catch (e: unknown) {
            return new ProblematicStorable(
              tag,
              deserializedState,
              e instanceof Error ? e.message : String(e),
            ) as unknown as StorableValue;
          }
        }
        return cls[RECONSTRUCT](
          deserializedState,
          runtime,
        ) as unknown as StorableValue;
      }

      // Unknown type: preserve for round-tripping.
      return new UnknownStorable(
        tag,
        deserializedState,
      ) as unknown as StorableValue;
    }

    // Primitives pass through.
    if (
      data === null || typeof data === "boolean" ||
      typeof data === "number" || typeof data === "string"
    ) {
      return data;
    }

    // Arrays: recursively deserialize elements.
    if (Array.isArray(data)) {
      let logicalLength = 0;
      for (const entry of data) {
        const entryDecoded = this.unwrapTag(entry);
        if (entryDecoded !== null && entryDecoded.tag === TAGS.hole) {
          logicalLength += entryDecoded.state as number;
        } else {
          logicalLength++;
        }
      }

      const result = new Array(logicalLength);
      let targetIndex = 0;
      for (const entry of data) {
        const entryDecoded = this.unwrapTag(entry);
        if (entryDecoded !== null && entryDecoded.tag === TAGS.hole) {
          targetIndex += entryDecoded.state as number;
        } else {
          result[targetIndex] = this.deserialize(entry, runtime, registry);
          targetIndex++;
        }
      }
      return Object.freeze(result);
    }

    // Plain objects: recursively deserialize values, then freeze.
    const result: Record<string, StorableValue> = {};
    for (const [key, val] of Object.entries(data)) {
      result[key] = this.deserialize(val, runtime, registry);
    }
    return Object.freeze(result);
  }

  // -------------------------------------------------------------------------
  // Legacy marker escaping (private)
  // -------------------------------------------------------------------------

  /**
   * Walk a parsed JSON tree and wrap any `/`-prefixed single-key objects
   * whose tag is not recognized by the serialization engine.
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
      const tag = keys[0].slice(1);

      if (tag === TAGS.object || tag === TAGS.quote) {
        return data;
      }

      if (KNOWN_TAGS.has(tag)) {
        const innerProcessed = this.escapeUnknownSlashKeys(obj[keys[0]]);
        if (innerProcessed !== obj[keys[0]]) {
          return { [keys[0]]: innerProcessed } as StorableValue;
        }
        return data;
      }

      const innerProcessed = this.escapeUnknownSlashKeys(obj[keys[0]]);
      return {
        [`/${TAGS.object}`]: { [keys[0]]: innerProcessed },
      } as StorableValue;
    }

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
