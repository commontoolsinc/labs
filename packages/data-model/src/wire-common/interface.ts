import type { Constructor } from "@commonfabric/utils/types";

import type { FabricInstance, FabricValue } from "@/interface.ts";

/**
 * Well-known symbol for binding the getter `FabricClassWithCodec[CODEC]`.
 */
export const CODEC: unique symbol = Symbol.for("data-model.codec");

/**
 * Well-known symbol for binding the method
 * `FabricDeconstructable[DECONSTRUCT]`.
 */
export const DECONSTRUCT: unique symbol = Symbol.for("data-model.deconstruct");

/**
 * Well-known symbol for binding the method
 * `FabricClass[RECONSTRUCT]`.
 */
export const RECONSTRUCT: unique symbol = Symbol.for("data-model.reconstruct");

/**
 * Interface for deconstructable fabric objects, which is all of them, but
 * TypeScript doesn't let us say that given how the class/interface hierarchy
 * under `FabricSpecialObject` is set up.
 */
export interface FabricDeconstructable {
  /**
   * Returns the essential state of this instance as a `FabricValue`.
   * Implementations must _not_ recursively deconstruct nested values; the
   * serialization system handles that.
   */
  [DECONSTRUCT](): FabricValue;
}

/**
 * Interface for codecs (encoder-decoder objects). These are object which can
 * extract "essential state" out of values (objects per se or otherwise) and
 * also take such "essential state" and produce values that are equivalent (in
 * a context-dependent sense) to the values that state was extracted from.
 */
export interface FabricCodec {
  /**
   * The unique _direct_ class of instances, if any, that is associated with the
   * format this instance encodes. The codec system uses this to make a quick
   * determination about value compatibility before calling {@link #canEncode}
   * to confirm.
   */
  get uniqueHandledClass(): Constructor | undefined;

  /**
   * The unique preferred wire format tag that is associated with the format
   * this instance decodes from, or `undefined` for a codec with no single
   * preferred tag. When defined, the codec system uses it to mark state
   * produced by {@link #encode} and (by default) routes state so marked back to
   * this instance (or an equivalent) for decoding; a codec with no tag is not
   * registered for tag-based decode dispatch.
   */
  get wireTypeTag(): string | undefined;

  /**
   * Returns `true` if this handler can encode the state of the given value.
   */
  canEncode(value: FabricValue): boolean;

  /**
   * Decodes a value from the given essential state, which is (alleged / supposed)
   * to be a value that was produced by an earlier call to {@link #encode} on
   * a compatible class to this one. The result is expected to be a _shallow_
   * decoding. The codec system handles recursively converting `state` contents
   * as necessary.
   *
   * The given `wireTypeTag` is what was associated with the given `state` and
   * does not necessarily correspond to {@link #wireTypeTag} (depending on how
   * an instance of this class got hooked up).
   */
  decode(
    wireTypeTag: string,
    state: FabricValue,
    context: ReconstructionContext,
  ): FabricValue;

  /**
   * Encodes the given value, returning its essential state. This is only ever
   * called after {@link #canEncode} has confirmed that `value` is encodable by
   * this instance. The result is expected to be a _shallow_ encoding. The codec
   * system handles recursion as necessary.
   */
  encode(value: FabricValue): FabricValue;
}

/**
 * Interface for classes that provide a `FabricCodec` which is guaranteed to
 * operate on instances of the class.
 */
export interface FabricClassWithCodec {
  /** The codec instance to use for instances of this class. */
  get [CODEC](): FabricCodec;
}

/**
 * Interface for classes that can reconstruct fabric objects from essential
 * state. The static `[RECONSTRUCT]` method is separate from the constructor
 * to support reconstruction-specific context and instance interning.
 * See Section 2.4 of the formal spec.
 */
export interface FabricClass<T extends FabricInstance> {
  /**
   * Reconstructs an instance from essential state. Nested values in `state`
   * have already been reconstructed by the serialization system. May return
   * an existing instance (interning) rather than creating a new one.
   */
  [RECONSTRUCT](state: FabricValue, context: ReconstructionContext): T;
}

/**
 * Converter that can reconstruct arbitrary values (not necessarily
 * fabric _objects_) from essential state. Used for built-in JS types like
 * `Error` that participate in the serialization protocol but don't implement
 * `FabricInstance`. See Section 1.4.1 of the formal spec.
 */
export interface FabricValueConverter<T> {
  /**
   * Reconstructs a value from essential state. Nested values in `state`
   * have already been reconstructed by the serialization system.
   */
  [RECONSTRUCT](state: FabricValue, context: ReconstructionContext): T;
}

/**
 * The minimal interface that `[RECONSTRUCT]` implementations may depend on.
 * Provided by the `Runtime` in practice, but defined as an interface here to
 * avoid a circular dependency between the fabric protocol and the runner.
 * See Section 2.5 of the formal spec.
 */
export interface ReconstructionContext {
  /** Resolves a cell reference. Used by types that need to intern or look up
   *  existing instances during reconstruction. */
  getCell(
    ref: { id: string; path: string[]; space: string },
  ): FabricInstance;

  /**
   * Signals whether a reconstruction call should produce a deep-frozen
   * result: `true` means the reconstructed value should be deep-frozen,
   * `false` means a mutable result is acceptable. Same contract as `frozen`
   * passed to `cloneIfNecessary()` (see `value-clone.ts`):
   * `shouldDeepFreeze === true` corresponds to
   * `cloneIfNecessary(value, { frozen: true })`.
   *
   * Required (not optional): every context declares it. Contexts get it for
   * free by extending `BaseReconstructionContext`, which centralizes the
   * getter; the `cloneIfNecessary`-style `true` default lives there.
   *
   * Enforcement: the concrete `[RECONSTRUCT]` implementations query this and
   * abide by it — they produce a deep-frozen result when it is `true`. The
   * one place this is *not* applied is the class-registry fallback
   * call-site wrap (`json-encoding-context.ts`'s `cls[RECONSTRUCT]` path);
   * that call-site deep-freeze is a separate follow-on's responsibility and
   * is intentionally NOT covered here. The per-implementation honoring is
   * sufficient for correctness regardless: each impl freezes its own output
   * when asked.
   */
  get shouldDeepFreeze(): boolean;
}

/**
 * Public boundary interface for serialization contexts. Encodes fabric
 * values into a serialized form and decodes them back. The type parameter
 * `SerializedForm` is the boundary type: `string` for JSON contexts,
 * `Uint8Array` for binary contexts.
 *
 * This is the only interface external callers need. Internal tree-walking
 * machinery is private to the context implementation.
 */
export interface SerializationContext<SerializedForm = unknown> {
  /** Whether failed reconstructions produce `ProblematicValue` instead of
   *  throwing. @default false */
  readonly lenient: boolean;

  /** Encodes a fabric value into serialized form for boundary crossing. */
  encode(value: FabricValue): SerializedForm;

  /** Decodes a serialized form back into a fabric value. */
  decode(
    data: SerializedForm,
    context: ReconstructionContext,
  ): FabricValue;
}
