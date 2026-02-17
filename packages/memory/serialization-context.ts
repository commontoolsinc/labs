import type { StorableClass, StorableInstance } from "./storable-protocol.ts";

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
 * The wire format for the JSON serialization context. Other contexts (e.g.,
 * CBOR) would define their own `SerializedForm`.
 */
export type SerializedForm = JsonValue;

/**
 * Maps between runtime types and wire format representations. Each boundary
 * in the system uses a serialization context appropriate to its format.
 * See Section 4.3 of the formal spec.
 */
export interface SerializationContext {
  /** Get the wire format tag for a storable instance's type. */
  getTagFor(value: StorableInstance): string;

  /** Get the class that can reconstruct instances for a given tag. */
  getClassFor(
    tag: string,
  ): StorableClass<StorableInstance> | undefined;

  /** Encode a tag and state into the format's wire representation. */
  encode(tag: string, state: SerializedForm): SerializedForm;

  /**
   * Decode a wire representation into tag and state, or `null` if not a
   * tagged value.
   */
  decode(
    data: SerializedForm,
  ): { tag: string; state: SerializedForm } | null;
}
