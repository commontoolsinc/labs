import type { StorableValue } from "./interface.ts";
import type { ReconstructionContext } from "./storable-protocol.ts";

/**
 * Public boundary interface for serialization contexts. Encodes storable
 * values into a serialized form and decodes them back. The type parameter
 * `SerializedForm` is the boundary type: `string` for JSON contexts,
 * `Uint8Array` for binary contexts.
 *
 * This is the only interface external callers need. Internal tree-walking
 * machinery is private to the context implementation.
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
