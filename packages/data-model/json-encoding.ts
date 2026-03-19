import type { FabricValue } from "./fabric-value.ts";
import { type FabricInstance, RECONSTRUCT } from "./storable-instance.ts";
import {
  type ReconstructionContext,
  type SerializationContext,
  type StorableClass,
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
 * - `decode(data, runtime)` -- full pipeline: parse + deserialize
 *
 * All internal machinery (tag wrapping, tree walking, byte conversion) is
 * private. Type handlers receive a narrow `TypeHandlerCodec` view of `this`
 * during tree walking.
 */
export class JsonEncodingContext implements SerializationContext<string> {
  /** Tag -> class registry for known types. */
  private readonly registry = new Map<
    string,
    StorableClass<FabricInstance>
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
      getTagFor: (value: FabricInstance) => this.getTagFor(value),
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
  encode(value: FabricValue): string {
    return JSON.stringify(this.serialize(value));
  }

  /**
   * Decode a JSON string back into a storable value. Parses the string,
   * then deserializes tagged forms back into rich runtime types.
   */
  decode(data: string, runtime: ReconstructionContext): FabricValue {
    const parsed = JSON.parse(data) as JsonWireValue;
    return this.deserialize(parsed, runtime);
  }

  // -------------------------------------------------------------------------
  // Byte-level boundary (public for now -- used by serializeToBytes tests)
  // -------------------------------------------------------------------------

  /**
   * Serialize a storable value to UTF-8 JSON bytes.
   */
  encodeToBytes(value: FabricValue): Uint8Array {
    return this.toBytes(this.serialize(value));
  }

  /**
   * Deserialize UTF-8 JSON bytes back into a storable value.
   */
  decodeFromBytes(
    bytes: Uint8Array,
    runtime: ReconstructionContext,
  ): FabricValue {
    const tree = this.fromBytes(bytes);
    return this.deserialize(tree, runtime);
  }

  // -------------------------------------------------------------------------
  // Tag wrapping/unwrapping (private)
  // -------------------------------------------------------------------------

  /** Get the wire format tag for a storable instance's type. */
  private getTagFor(value: FabricInstance): string {
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
  ): StorableClass<FabricInstance> | undefined {
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
    value: FabricValue,
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
        (v: FabricValue) => this.serialize(v, seen, registry),
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
            this.serialize(value[i] as FabricValue, seen, registry),
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
        value as Record<string, FabricValue>,
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
  ): FabricValue {
    const decoded = this.unwrapTag(data);
    if (decoded !== null) {
      const { tag, state } = decoded;

      // `TAGS.object` unwrapping (Section 5.6).
      if (tag === TAGS.object) {
        const inner = state as Record<string, JsonWireValue>;
        const result: Record<string, FabricValue> = {};
        for (const [key, val] of Object.entries(inner)) {
          result[key] = this.deserialize(val, runtime, registry);
        }
        return Object.freeze(result);
      }

      // `TAGS.quote` literal handling (Section 5.6).
      if (tag === TAGS.quote) {
        return deepFreeze(state) as FabricValue;
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
              state as unknown as FabricValue,
              e instanceof Error ? e.message : String(e),
            ) as unknown as FabricValue;
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
            ) as unknown as FabricValue;
          } catch (e: unknown) {
            return new ProblematicStorable(
              tag,
              deserializedState,
              e instanceof Error ? e.message : String(e),
            ) as unknown as FabricValue;
          }
        }
        return cls[RECONSTRUCT](
          deserializedState,
          runtime,
        ) as unknown as FabricValue;
      }

      // Unknown type: preserve for round-tripping.
      return new UnknownStorable(
        tag,
        deserializedState,
      ) as unknown as FabricValue;
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
    const result: Record<string, FabricValue> = {};
    for (const [key, val] of Object.entries(data)) {
      result[key] = this.deserialize(val, runtime, registry);
    }
    return Object.freeze(result);
  }
}
