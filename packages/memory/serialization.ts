import type { StorableValue } from "./interface.ts";
import {
  DECONSTRUCT,
  isStorable,
  RECONSTRUCT,
  type ReconstructionContext,
} from "./storable-protocol.ts";
import type {
  SerializationContext,
  SerializedForm,
} from "./serialization-context.ts";
import { UnknownStorable } from "./unknown-storable.ts";
import { ProblematicStorable } from "./problematic-storable.ts";

/**
 * Serialize a storable value for boundary crossing. Recursively processes
 * nested values. See Section 4.5 of the formal spec.
 *
 * Circular references are detected and throw an error.
 */
export function serialize(
  value: StorableValue,
  context: SerializationContext,
  _seen?: Set<object>,
): SerializedForm {
  // --- StorableInstance (custom protocol) ---
  if (isStorable(value)) {
    // UnknownStorable and ProblematicStorable: use preserved typeTag
    // and re-serialize their stored state.
    if (value instanceof UnknownStorable) {
      const serializedState = serialize(value.state, context, _seen);
      return context.encode(value.typeTag, serializedState);
    }
    if (value instanceof ProblematicStorable) {
      const serializedState = serialize(value.state, context, _seen);
      return context.encode(value.typeTag, serializedState);
    }

    const state = value[DECONSTRUCT]();
    const tag = context.getTagFor(value);
    const serializedState = serialize(state, context, _seen);
    return context.encode(tag, serializedState);
  }

  // --- Built-in JS types with derived StorableInstance form (Section 1.4.1) ---

  if (value instanceof Error) {
    const seen = _seen ?? new Set<object>();
    if (seen.has(value)) {
      throw new Error("Circular reference detected during serialization");
    }
    seen.add(value);

    const state: Record<string, SerializedForm> = {
      name: serialize(value.name, context, seen) as SerializedForm,
      message: serialize(value.message, context, seen) as SerializedForm,
    };
    if (value.stack !== undefined) {
      state.stack = serialize(value.stack, context, seen) as SerializedForm;
    }
    if (value.cause !== undefined) {
      state.cause = serialize(
        value.cause as StorableValue,
        context,
        seen,
      ) as SerializedForm;
    }
    // Copy custom enumerable properties.
    for (const key of Object.keys(value)) {
      if (!(key in state)) {
        state[key] = serialize(
          (value as unknown as Record<string, unknown>)[key] as StorableValue,
          context,
          seen,
        ) as SerializedForm;
      }
    }

    seen.delete(value);
    return context.encode("Error@1", state as SerializedForm);
  }

  // --- `undefined` ---
  if (value === undefined) {
    return context.encode("Undefined@1", null);
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
    let i = 0;
    while (i < value.length) {
      if (!(i in value)) {
        // Count consecutive holes starting at index `i` (maximal runs).
        let count = 0;
        while (i < value.length && !(i in value)) {
          count++;
          i++;
        }
        result.push(context.encode("Hole@1", count));
      } else {
        result.push(
          serialize(value[i] as StorableValue, context, seen),
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
    result[key] = serialize(val, context, seen);
  }

  seen.delete(value as object);

  // Apply `/object` escaping per Section 5.6: if the result has exactly one
  // key and that key starts with `/`, wrap in `{ "/object": ... }` so the
  // deserializer does not misinterpret it as a tagged type.
  const keys = Object.keys(result);
  if (keys.length === 1 && keys[0].startsWith("/")) {
    return { "/object": result } as SerializedForm;
  }

  return result as SerializedForm;
}

/**
 * Deserialize a wire-format value back into rich runtime types. Requires a
 * `ReconstructionContext` for reconstituting types that need runtime context
 * (e.g., `Cell` interning). See Section 4.5 of the formal spec.
 */
export function deserialize(
  data: SerializedForm,
  context: SerializationContext,
  runtime: ReconstructionContext,
): StorableValue {
  const decoded = context.decode(data);
  if (decoded !== null) {
    const { tag, state } = decoded;

    // `/object` unwrapping (Section 5.6): strip the wrapper and take the
    // inner object's keys literally; inner values go through normal
    // deserialization.
    if (tag === "object") {
      const inner = state as Record<string, SerializedForm>;
      const result: Record<string, StorableValue> = {};
      for (const [key, val] of Object.entries(inner)) {
        result[key] = deserialize(val, context, runtime);
      }
      return Object.freeze(result);
    }

    // `/quote` literal handling (Section 5.6): return the inner value as-is
    // with no deserialization of nested special forms.
    if (tag === "quote") {
      return state as StorableValue;
    }

    // `Undefined@1`: produces the JS value `undefined`.
    if (tag === "Undefined@1") {
      return undefined;
    }

    // `Hole@1` outside of array deserialization is treated as an unknown type
    // for safety (array deserialization handles Hole@1 inline below).

    const cls = context.getClassFor(tag);
    const deserializedState = deserialize(state, context, runtime);

    if (cls) {
      // In lenient mode, catch reconstruction failures and wrap them.
      if ("lenient" in context && (context as { lenient: boolean }).lenient) {
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

  // Arrays: recursively deserialize elements. `Hole@1` entries use
  // run-length encoding -- the state is a positive integer indicating how
  // many consecutive holes to skip.
  if (Array.isArray(data)) {
    // First pass: compute the logical length.
    let logicalLength = 0;
    for (const entry of data) {
      const entryDecoded = context.decode(entry);
      if (entryDecoded !== null && entryDecoded.tag === "Hole@1") {
        logicalLength += entryDecoded.state as number;
      } else {
        logicalLength++;
      }
    }

    const result = new Array(logicalLength);
    let targetIndex = 0;
    for (const entry of data) {
      const entryDecoded = context.decode(entry);
      if (entryDecoded !== null && entryDecoded.tag === "Hole@1") {
        // Skip `state` indices -- leave them absent, creating true holes.
        targetIndex += entryDecoded.state as number;
      } else {
        result[targetIndex] = deserialize(entry, context, runtime);
        targetIndex++;
      }
    }
    return Object.freeze(result);
  }

  // Plain objects: recursively deserialize values, then freeze.
  const result: Record<string, StorableValue> = {};
  for (const [key, val] of Object.entries(data)) {
    result[key] = deserialize(val, context, runtime);
  }
  return Object.freeze(result);
}
