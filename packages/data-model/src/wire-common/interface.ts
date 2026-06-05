import type { FabricInstance, FabricValue } from "../interface.ts";

/**
 * Well-known symbol for reconstructing a fabric instance from its essential
 * state. Static method on the class.
 * See Section 2.2 of the formal spec.
 */
export const RECONSTRUCT: unique symbol = Symbol.for("common.reconstruct");

/**
 * Interface for classes that can reconstruct fabric instances from essential
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
 * `FabricInstance`s) from essential state. Used for built-in JS types like
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
    runtime: ReconstructionContext,
  ): FabricValue;
}
