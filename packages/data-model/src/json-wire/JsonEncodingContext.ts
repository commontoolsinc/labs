import {
  type FabricClass,
  type FabricInstance,
  type FabricValue,
  RECONSTRUCT,
  type ReconstructionContext,
  type SerializationContext,
} from "../interface.ts";
import { ExplicitTagValue } from "../fabric-instances/ExplicitTagValue.ts";
import { deepFreeze } from "../deep-freeze.ts";
import { UnknownValue } from "../fabric-instances/UnknownValue.ts";
import { ProblematicValue } from "../fabric-instances/ProblematicValue.ts";
import { createDefaultRegistry } from "./createDefaultRegistry.ts";
import type { JsonWireValue, TypeHandlerCodec } from "./interface.ts";
import type { TypeHandlerRegistry } from "./TypeHandlerRegistry.ts";
import { FabricError } from "../fabric-instances/FabricError.ts";
import { FabricMap } from "../fabric-instances/FabricMap.ts";
import { FabricRegExp } from "../fabric-instances/FabricRegExp.ts";
import { FabricSet } from "../fabric-instances/FabricSet.ts";
import { TAGS } from "../fabric-type-tags.ts";
import { utf8SortedKeysOf } from "@commonfabric/utils/utf8";

/**
 * Tag prefix for the encoded form used by this module. We use this explicit
 * prefix so as to make it unambiguous when a given JSON-ish text string is
 * the result of encoding via this module vs. being JSON from some other source.
 * The tag stands for "Fabric Value Json, version 1."
 */
const ENCODING_PREFIX_TAG = "fvj1:";

/** Shared text encoder, created once. */
const textEncoder = new TextEncoder();

/** Shared text decoder, created once. */
const textDecoder = new TextDecoder();

/** Shared default handler registry, created once. */
const defaultRegistry: TypeHandlerRegistry = createDefaultRegistry();

/** Returns true if `v` is a single-key object whose key starts with `/` —
 * the wire form of an encoded instance (tag-wrapped value). */
function isEncodedInstance(v: JsonWireValue): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 1 && keys[0].startsWith("/");
}

/**
 * Returns true if the already-serialized wire value `v` can be embedded
 * inside a /quote wrap without inner deserialization: primitives, plain
 * objects/arrays free of non-/quote encoded instances, and /quote-wrapped
 * values (which `unquote()` can collapse).
 */
function isQuoteSafe(v: JsonWireValue): boolean {
  if (v === null || typeof v !== "object") return true;
  if (Array.isArray(v)) return v.every((item) => isQuoteSafe(item));
  if (!isEncodedInstance(v)) {
    return Object.values(v).every((item) => isQuoteSafe(item as JsonWireValue));
  }
  return Object.keys(v)[0] === "/quote";
}

/**
 * Unwraps /quote forms one level so their literal content can be embedded
 * directly inside a parent /quote. The inner content of a /quote is already
 * literal and must not be recursed into.
 */
function unquote(v: JsonWireValue): JsonWireValue {
  if (v === null || typeof v !== "object") {
    return v;
  } else if (Array.isArray(v)) {
    const result = v.map(unquote) as JsonWireValue;
    return Object.freeze(result);
  } else if (isEncodedInstance(v) && Object.keys(v)[0] === "/quote") {
    return (v as Record<string, JsonWireValue>)["/quote"];
  } else {
    const result = Object.fromEntries(
      Object.entries(v).map(([k, val]) => [k, unquote(val as JsonWireValue)]),
    ) as JsonWireValue;
    return Object.freeze(result);
  }
}

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
    FabricClass<FabricInstance>
  >();

  /** Whether failed reconstructions produce `ProblematicValue` instead of
   *  throwing. */
  readonly lenient: boolean;

  /** Narrow codec view for type handlers (avoids exposing private methods). */
  private readonly codec: TypeHandlerCodec;

  /**
   * Constructs an instance, optionally configured for lenient mode (which
   * produces `ProblematicValue` on failed reconstruction instead of throwing).
   */
  constructor(options?: { lenient?: boolean }) {
    this.lenient = options?.lenient ?? false;

    // Create a codec view that delegates to our private methods.
    this.codec = {
      wrapTag: (tag: string, state: JsonWireValue) => this.wrapTag(tag, state),
      getTagFor: (value: FabricInstance) => this.getTagFor(value),
    };

    // Register native wrapper classes for deserialization. Each wrapper's
    // static `[RECONSTRUCT]` method is used by the class registry fallback
    // path in `deserialize()`.
    this.registry.set(TAGS.Error, FabricError);
    this.registry.set(TAGS.Map, FabricMap);
    this.registry.set(TAGS.Set, FabricSet);
    this.registry.set(TAGS.RegExp, FabricRegExp);
  }

  //
  // `SerializationContext<string>` -- public boundary interface
  //

  /**
   * Encodes a fabric value to a JSON string. Serializes modern types into
   * the `/<Type>@<Version>` tagged wire format, then stringifies.
   */
  encode(value: FabricValue): string {
    return ENCODING_PREFIX_TAG + JSON.stringify(this.serialize(value));
  }

  /**
   * Decodes a JSON string back into a fabric value. Parses the string,
   * then deserializes tagged forms back into modern runtime types.
   */
  decode(data: string, runtime: ReconstructionContext): FabricValue {
    if (!JsonEncodingContext.seemsLikeEncoded(data)) {
      const excerpt = (data.length <= 50) ? data : `${data.slice(0, 50)}...`;
      throw new Error(
        `Not a JSON-encoded \`FabricValue\` string: \`${excerpt}\``,
      );
    }

    const json = data.slice(ENCODING_PREFIX_TAG.length);
    const parsed = JsonEncodingContext.#parseWireText(json);
    return this.deserialize(parsed, runtime);
  }

  // -------------------------------------------------------------------------
  // Static helpers
  // -------------------------------------------------------------------------

  /**
   * Indicates if the given text has a "first-blush" appearance as valid JSON
   * encoded by this class -- that is, whether it carries the encoding prefix
   * tag.
   */
  static seemsLikeEncoded(value: string): boolean {
    return value.startsWith(ENCODING_PREFIX_TAG);
  }

  // -------------------------------------------------------------------------
  // Byte-level boundary (public for now -- used by serializeToBytes tests)
  // -------------------------------------------------------------------------

  /**
   * Serializes a fabric value to UTF-8 JSON bytes.
   */
  encodeToBytes(value: FabricValue): Uint8Array {
    return this.toBytes(this.serialize(value));
  }

  /**
   * Deserializes UTF-8 JSON bytes back into a fabric value.
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

  /** Returns the wire format tag for a fabric instance's type. */
  private getTagFor(value: FabricInstance): string {
    if (value instanceof ExplicitTagValue) {
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

  /** Returns the class that can reconstruct instances for a given tag. */
  private getClassFor(
    tag: string,
  ): FabricClass<FabricInstance> | undefined {
    return this.registry.get(tag);
  }

  /**
   * Wraps a tag and state into the `/<tag>` wire format. Prepends `/` to the
   * tag to produce the JSON key. See Section 5.2 of the formal spec.
   */
  private wrapTag(tag: string, state: JsonWireValue): JsonWireValue {
    return Object.freeze({ [`/${tag}`]: state } as JsonWireValue);
  }

  /**
   * Unwraps a wire representation. Detects single-key objects with `/`-prefixed
   * keys. Returns `{ tag, state }` or `null` if not a tagged value. The
   * returned `state` is extracted directly from `data`, so if `data` is
   * deep-frozen (as it should be) then `state` will be too.
   *
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

    if (!isEncodedInstance(data)) {
      return null;
    }

    const key = Object.keys(data)[0];
    const tag = key.slice(1);
    const state = (data as Record<string, JsonWireValue>)[key];
    return { tag, state };
  }

  // -------------------------------------------------------------------------
  // Byte conversion (private)
  // -------------------------------------------------------------------------

  /** Converts a wire-format tree to UTF-8-encoded JSON bytes. */
  private toBytes(data: JsonWireValue): Uint8Array {
    return textEncoder.encode(JSON.stringify(data));
  }

  /** Parses UTF-8-encoded JSON bytes back into a wire-format tree. */
  private fromBytes(bytes: Uint8Array): JsonWireValue {
    const json = textDecoder.decode(bytes);
    return JsonEncodingContext.#parseWireText(json);
  }

  //
  // Tree-walking serialization (private)
  //
  // Moved from serialization.ts. These methods walk the value tree,
  // dispatching to type handlers and applying structural escaping.
  //

  /**
   * Serializes a fabric value into wire format. Recursively processes nested
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

    // Primitives.
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

    // Iterate keys in UTF-8 byte order. This matches the canonical key order
    // used by `value-hash.ts`, and makes JSON encoding deterministic across
    // implementations and across objects whose keys differ only in insertion
    // order. See `3-json-encoding.md` Section 10 for the spec.
    const result: Record<string, JsonWireValue> = {};
    const valueRec = value as Record<string, FabricValue>;
    for (const key of utf8SortedKeysOf(valueRec)) {
      result[key] = this.serialize(valueRec[key], seen, registry);
    }
    seen.delete(value as object);

    // Apply escaping per Section 5.6 for plain objects with /-prefixed keys.
    // Serialize all values first (post-pass), then check if all are quote-safe.
    // If so, unwrap any /quote children and wrap the whole object with /quote.
    // Otherwise wrap with /object so the decoder deserializes entries.
    const keys = Object.keys(result);
    if (keys.some((k) => k.startsWith("/"))) {
      if (Object.values(result).every((v) => isQuoteSafe(v))) {
        const unquoted = Object.freeze(
          Object.fromEntries(
            Object.entries(result).map(([k, v]) => [k, unquote(v)]),
          ),
        );
        return this.wrapTag(TAGS.quote, unquoted) as JsonWireValue;
      }
      return this.wrapTag(TAGS.object, result) as JsonWireValue;
    }

    return result as JsonWireValue;
  }

  // -------------------------------------------------------------------------
  // Tree-walking deserialization (private)
  // -------------------------------------------------------------------------

  /**
   * Deserializes a wire-format value back into modern runtime types.
   * See Section 4.5 of the formal spec.
   *
   * Frozen-ness contract: values returned via the type-handler dispatch arm
   * are guaranteed deep-frozen at this boundary, so callers do not each have
   * to freeze. The class-registry fallback arm is a separate sibling branch
   * and is intentionally NOT covered by this contract.
   */
  private deserialize(
    data: JsonWireValue,
    runtime: ReconstructionContext,
    registry: TypeHandlerRegistry = defaultRegistry,
  ): FabricValue {
    const decoded = this.unwrapTag(data);
    if (decoded !== null) {
      const { tag, state } = decoded;

      // A bare `"/"` key (empty tag after stripping the leading slash) is
      // always an encoding error per spec §9 — no valid tag has an empty
      // name. Produce a `ProblematicValue` rather than an `UnknownValue` with
      // an empty tag.
      if (tag === "") {
        return new ProblematicValue(
          tag,
          state as unknown as FabricValue,
          `object has bare "/" key`,
        ) as unknown as FabricValue;
      }

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
        return state as FabricValue;
      }

      // Type handler dispatch.
      //
      // `TypeHandler.deserialize()` makes a contractual guarantee that its
      // results are deep-frozen, rather than relying on every caller to
      // freeze: every return out of this arm passes through `deepFreeze()`.
      // This covers the handler's produced value (e.g. `FabricPrimitive`
      // subclasses -- already frozen, so this is an O(1) cache hit) and the
      // lenient-mode `ProblematicValue` fallback. The class-registry
      // fallback below is a separate arm and is intentionally NOT covered by
      // this contract.
      const handler = registry.getDeserializer(tag);
      if (handler) {
        if (this.lenient) {
          try {
            return deepFreeze(handler.deserialize(
              state,
              runtime,
              (v: JsonWireValue) => this.deserialize(v, runtime, registry),
            ));
          } catch (e: unknown) {
            return deepFreeze(
              new ProblematicValue(
                tag,
                state as unknown as FabricValue,
                e instanceof Error ? e.message : String(e),
              ) as unknown as FabricValue,
            );
          }
        }
        return deepFreeze(handler.deserialize(
          state,
          runtime,
          (v: JsonWireValue) => this.deserialize(v, runtime, registry),
        ));
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
            return new ProblematicValue(
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
      return new UnknownValue(
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

    // Plain objects: recursively deserialize values and freeze. Any
    // `/`-prefixed key is reserved per spec — return `ProblematicValue` on
    // first occurrence rather than silently round-tripping the object.
    const result: Record<string, FabricValue> = {};
    for (const [key, val] of Object.entries(data)) {
      if (key.startsWith("/")) {
        return new ProblematicValue(
          key.slice(1),
          data as unknown as FabricValue,
          `object contains reserved /-prefixed key: "${key}"`,
        ) as unknown as FabricValue;
      }
      result[key] = this.deserialize(val, runtime, registry);
    }
    return Object.freeze(result);
  }

  /**
   * Parses the JSON-text wire form, _without_ a tag prefix.
   */
  static #parseWireText(jsonText: string): JsonWireValue {
    return deepFreeze(JSON.parse(jsonText) as JsonWireValue);
  }
}
