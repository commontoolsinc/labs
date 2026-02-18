import type { SerializationContext } from "./serialization-context.ts";

/**
 * JSON-compatible wire format value. Distinct from the existing `JSONValue` in
 * `@commontools/api` -- this type represents the wire format for the new
 * `/<Type>@<Version>` encoding. See Section 4.2 of the formal spec.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * The wire format for the JSON serialization context. Alias for `JsonValue`,
 * used throughout the serialization system to make the wire format explicit.
 */
export type SerializedForm = JsonValue;

/**
 * JSON-specific serialization context. Implements the `/<Type>@<Version>` wire
 * format, parameterized as `SerializationContext<JsonValue>`.
 * See Section 4.3 of the formal spec.
 */
export type JsonSerializationContext = SerializationContext<JsonValue>;

/**
 * Re-export `SerializationContext` so existing consumers of this module can
 * still import it from here during the transition.
 */
export type { SerializationContext } from "./serialization-context.ts";

/**
 * Convenience type guard: checks if a `SerializationContext` is a JSON context
 * (i.e., its serialized form is `JsonValue`). Useful for code that needs to
 * distinguish JSON contexts from potential future binary contexts.
 */
export function isJsonContext(
  _context: SerializationContext<unknown>,
): _context is JsonSerializationContext {
  // For now, all contexts are JSON contexts. This will become meaningful
  // when binary contexts are introduced.
  return true;
}
