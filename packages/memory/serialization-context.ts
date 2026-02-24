import type { StorableClass, StorableInstance } from "./storable-protocol.ts";

/**
 * Maps between runtime types and wire format representations. Parameterized
 * on `WireFormat` -- the type of the intermediate serialized representation.
 * JSON contexts use `JsonWireValue` (an intermediate tree that `JSON.stringify`
 * converts to bytes); future binary contexts would use `Uint8Array`.
 * See Section 4.3 of the formal spec.
 */
export interface SerializationContext<WireFormat = unknown> {
  /** Whether failed reconstructions produce `ProblematicStorable` instead of
   *  throwing. @default false */
  readonly lenient: boolean;

  /** Get the wire format tag for a storable instance's type. */
  getTagFor(value: StorableInstance): string;

  /** Get the class that can reconstruct instances for a given tag. */
  getClassFor(
    tag: string,
  ): StorableClass<StorableInstance> | undefined;

  /** Encode a tag and state into the format's wire representation. */
  encode(tag: string, state: WireFormat): WireFormat;

  /**
   * Decode a wire representation into tag and state, or `null` if not a
   * tagged value.
   */
  decode(
    data: WireFormat,
  ): { tag: string; state: WireFormat } | null;
}
