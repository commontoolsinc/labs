import type { StorableValue } from "./interface.ts";
import type {
  ReconstructionContext,
  StorableClass,
  StorableInstance,
} from "./storable-protocol.ts";

/**
 * Public boundary interface for serialization contexts. Encodes storable
 * values into a serialized form and decodes them back. The type parameter
 * `SerializedForm` is the boundary type: `string` for JSON contexts,
 * `Uint8Array` for binary contexts.
 *
 * This is the only interface external callers need. Internal tree-walking
 * machinery uses the `TagCodec` interface instead.
 */
export interface SerializationContext<SerializedForm = unknown> {
  /** Whether failed reconstructions produce `ProblematicStorable` instead of
   *  throwing. @default false */
  readonly lenient: boolean;

  /** Encode a storable value into serialized form for boundary crossing. */
  encode(value: StorableValue): SerializedForm;

  /** Decode a serialized form back into a storable value. */
  decode(
    data: SerializedForm,
    runtime: ReconstructionContext,
  ): StorableValue;
}

/**
 * Internal interface for tag-level encoding during tree walking. Maps between
 * runtime type tags and wire format representations. Parameterized on
 * `WireFormat` -- the intermediate representation used during tree traversal
 * (e.g., `JsonWireValue` for JSON contexts).
 *
 * This is NOT the public serialization boundary. External callers use
 * `SerializationContext` instead. `TagCodec` is used by `serialize()`,
 * `deserialize()`, and type handlers during internal tree walking.
 */
export interface TagCodec<WireFormat = unknown> {
  /** Whether failed reconstructions produce `ProblematicStorable` instead of
   *  throwing. @default false */
  readonly lenient: boolean;

  /** Get the wire format tag for a storable instance's type. */
  getTagFor(value: StorableInstance): string;

  /** Get the class that can reconstruct instances for a given tag. */
  getClassFor(
    tag: string,
  ): StorableClass<StorableInstance> | undefined;

  /** Wrap a tag and state into the wire format's tagged representation. */
  wrapTag(tag: string, state: WireFormat): WireFormat;

  /**
   * Unwrap a wire format value into tag and state, or `null` if not a
   * tagged value.
   */
  unwrapTag(
    data: WireFormat,
  ): { tag: string; state: WireFormat } | null;
}
