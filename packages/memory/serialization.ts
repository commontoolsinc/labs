import type { StorableValue } from "./interface.ts";
import {
  RECONSTRUCT,
  type ReconstructionContext,
} from "./storable-protocol.ts";
import type { TagCodec } from "./serialization-context.ts";
import type { SerializedForm } from "./json-serialization-context.ts";
import { deepFreeze } from "./deep-freeze.ts";
import { UnknownStorable } from "./unknown-storable.ts";
import { ProblematicStorable } from "./problematic-storable.ts";
import {
  createDefaultRegistry,
  type TypeHandlerRegistry,
} from "./type-handlers.ts";
import { TAGS } from "./type-tags.ts";

/** Shared default handler registry, created once. */
const defaultRegistry: TypeHandlerRegistry = createDefaultRegistry();

/**
 * A tag codec that can also produce and consume `Uint8Array` bytes.
 * Extends the base `TagCodec` with `finalize()` and `parse()` methods for
 * byte-level boundary crossing. `JsonEncodingContext` implements this.
 */
export interface ByteTagCodec<WireFormat> extends TagCodec<WireFormat> {
  /** Convert a wire-format tree to bytes for boundary crossing. */
  finalize(data: WireFormat): Uint8Array;
  /** Parse bytes back into a wire-format tree. */
  parse(bytes: Uint8Array): WireFormat;
}

// ---------------------------------------------------------------------------
// Public API: Uint8Array boundary
// ---------------------------------------------------------------------------

/**
 * Serialize a storable value to bytes for boundary crossing. Builds an
 * internal wire-format tree via the codec, then converts to `Uint8Array`
 * via `codec.finalize()`. See Section 4.5 of the formal spec.
 *
 * This is the intended public API for serialization at system boundaries.
 * The tree-level `serialize()` function is also exported for internal use
 * and testing.
 */
export function serializeToBytes(
  value: StorableValue,
  codec: ByteTagCodec<SerializedForm>,
  registry: TypeHandlerRegistry = defaultRegistry,
): Uint8Array {
  const tree = serialize(value, codec, undefined, registry);
  return codec.finalize(tree);
}

/**
 * Deserialize bytes back into rich runtime types. Parses the `Uint8Array`
 * via `codec.parse()` into an internal wire-format tree, then walks it
 * to reconstruct runtime values.
 *
 * This is the intended public API for deserialization at system boundaries.
 * The tree-level `deserialize()` function is also exported for internal use
 * and testing.
 */
export function deserializeFromBytes(
  bytes: Uint8Array,
  codec: ByteTagCodec<SerializedForm>,
  runtime: ReconstructionContext,
  registry: TypeHandlerRegistry = defaultRegistry,
): StorableValue {
  const tree = codec.parse(bytes);
  return deserialize(tree, codec, runtime, registry);
}

/**
 * Serialize a storable value into wire format. Recursively processes nested
 * values using the tag codec for type-tagged encoding. See Section 4.5 of
 * the formal spec.
 *
 * Type handlers are dispatched via the `registry`. If no handler matches,
 * the value is treated as a primitive, array, or plain object.
 *
 * Circular references are detected and throw an error.
 */
export function serialize(
  value: StorableValue,
  codec: TagCodec<SerializedForm>,
  _seen?: Set<object>,
  registry: TypeHandlerRegistry = defaultRegistry,
): SerializedForm {
  // --- Try type handlers first ---
  const handler = registry.findSerializer(value);
  if (handler) {
    const seen = _seen ?? new Set<object>();

    // Cycle detection for object-typed values.
    if (value !== null && typeof value === "object") {
      if (seen.has(value as object)) {
        throw new Error("Circular reference detected during serialization");
      }
      seen.add(value as object);
    }

    const result = handler.serialize(
      value,
      codec,
      (v: StorableValue) => serialize(v, codec, seen, registry),
    );

    // Remove from seen set to allow shared references.
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
    return value as SerializedForm;
  }

  // --- Arrays ---
  if (Array.isArray(value)) {
    const seen = _seen ?? new Set<object>();
    if (seen.has(value)) {
      throw new Error("Circular reference detected during serialization");
    }
    seen.add(value);

    const result: SerializedForm[] = [];
    // Note: this loop iterates by index over `value.length`. For very sparse
    // arrays with a large `.length` but few actual elements, this is O(length)
    // not O(elements). The inner hole-counting loop coalesces consecutive
    // absent indices into run-length-encoded `/hole` entries, so the output
    // is compact, but the iteration cost is proportional to `.length`.
    let i = 0;
    while (i < value.length) {
      if (!(i in value)) {
        // Count consecutive holes starting at index `i` (maximal runs).
        let count = 0;
        while (i < value.length && !(i in value)) {
          count++;
          i++;
        }
        result.push(codec.wrapTag(TAGS.hole, count));
      } else {
        result.push(
          serialize(value[i] as StorableValue, codec, seen, registry),
        );
        i++;
      }
    }

    seen.delete(value);
    return result as SerializedForm;
  }

  // --- Plain objects ---
  const seen = _seen ?? new Set<object>();
  if (seen.has(value as object)) {
    throw new Error("Circular reference detected during serialization");
  }
  seen.add(value as object);

  const result: Record<string, SerializedForm> = {};
  for (
    const [key, val] of Object.entries(
      value as Record<string, StorableValue>,
    )
  ) {
    result[key] = serialize(val, codec, seen, registry);
  }

  seen.delete(value as object);

  // Apply `TAGS.object` escaping per Section 5.6: if the result has exactly
  // one key and that key starts with `/`, wrap in `{ "/object": ... }` so the
  // deserializer does not misinterpret it as a tagged type.
  const keys = Object.keys(result);
  if (keys.length === 1 && keys[0].startsWith("/")) {
    return codec.wrapTag(TAGS.object, result) as SerializedForm;
  }

  return result as SerializedForm;
}

/**
 * Deserialize a wire-format value back into rich runtime types. Requires a
 * `ReconstructionContext` for reconstituting types that need runtime context
 * (e.g., `Cell` interning). See Section 4.5 of the formal spec.
 *
 * Tagged values are dispatched to handlers via tag lookup. Structural meta-
 * tags (`object`, `quote`) and primitives/arrays/objects are handled inline.
 */
export function deserialize(
  data: SerializedForm,
  codec: TagCodec<SerializedForm>,
  runtime: ReconstructionContext,
  registry: TypeHandlerRegistry = defaultRegistry,
): StorableValue {
  const decoded = codec.unwrapTag(data);
  if (decoded !== null) {
    const { tag, state } = decoded;

    // `TAGS.object` unwrapping (Section 5.6): strip the wrapper and take the
    // inner object's keys literally; inner values go through normal
    // deserialization.
    if (tag === TAGS.object) {
      const inner = state as Record<string, SerializedForm>;
      const result: Record<string, StorableValue> = {};
      for (const [key, val] of Object.entries(inner)) {
        result[key] = deserialize(val, codec, runtime, registry);
      }
      return Object.freeze(result);
    }

    // `TAGS.quote` literal handling (Section 5.6): return the inner value
    // as-is with no deserialization of nested special forms. Deep-freeze
    // arrays and plain objects so the freeze guarantee applies uniformly
    // to all `deserialize()` output.
    if (tag === TAGS.quote) {
      return deepFreeze(state) as StorableValue;
    }

    // --- Type handler dispatch (map-based tag lookup) ---
    const handler = registry.getDeserializer(tag);
    if (handler) {
      if (codec.lenient) {
        try {
          return handler.deserialize(
            state,
            codec,
            runtime,
            (v: SerializedForm) => deserialize(v, codec, runtime, registry),
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
        codec,
        runtime,
        (v: SerializedForm) => deserialize(v, codec, runtime, registry),
      );
    }

    // --- Class registry fallback (for tags not in handler registry) ---
    const cls = codec.getClassFor(tag);
    const deserializedState = deserialize(state, codec, runtime, registry);

    if (cls) {
      // In lenient mode, catch reconstruction failures and wrap them.
      if (codec.lenient) {
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

    // Unknown type: preserve for round-tripping via `UnknownStorable`.
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

  // Arrays: recursively deserialize elements. `TAGS.hole` entries use
  // run-length encoding -- the state is a positive integer indicating how
  // many consecutive holes to skip.
  if (Array.isArray(data)) {
    // Two-pass decode: the first pass computes the logical array length so we
    // can pre-allocate with `new Array(logicalLength)`, which produces true
    // sparse holes (absent indices) rather than `undefined` entries. The second
    // pass fills in elements. Each entry's `codec.unwrapTag()` is called twice,
    // but unwrapTag is cheap (single-key object inspection), and the alternative
    // (single-pass with dynamic resizing) would require post-hoc hole creation.
    let logicalLength = 0;
    for (const entry of data) {
      const entryDecoded = codec.unwrapTag(entry);
      if (entryDecoded !== null && entryDecoded.tag === TAGS.hole) {
        logicalLength += entryDecoded.state as number;
      } else {
        logicalLength++;
      }
    }

    const result = new Array(logicalLength);
    let targetIndex = 0;
    for (const entry of data) {
      const entryDecoded = codec.unwrapTag(entry);
      if (entryDecoded !== null && entryDecoded.tag === TAGS.hole) {
        // Skip `state` indices -- leave them absent, creating true holes.
        targetIndex += entryDecoded.state as number;
      } else {
        result[targetIndex] = deserialize(entry, codec, runtime, registry);
        targetIndex++;
      }
    }
    return Object.freeze(result);
  }

  // Plain objects: recursively deserialize values, then freeze.
  const result: Record<string, StorableValue> = {};
  for (const [key, val] of Object.entries(data)) {
    result[key] = deserialize(val, codec, runtime, registry);
  }
  return Object.freeze(result);
}
