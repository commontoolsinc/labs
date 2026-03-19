import type { FabricValue } from "./fabric-value.ts";

import { FabricInstance, RECONSTRUCT } from "./storable-instance.ts";

/**
 * A class that can reconstruct storable instances from essential state. The
 * static `[RECONSTRUCT]` method is separate from the constructor to support
 * reconstruction-specific context and instance interning.
 * See Section 2.4 of the formal spec.
 */
export interface StorableClass<T extends FabricInstance> {
  /**
   * Reconstruct an instance from essential state. Nested values in `state`
   * have already been reconstructed by the serialization system. May return
   * an existing instance (interning) rather than creating a new one.
   */
  [RECONSTRUCT](state: FabricValue, context: ReconstructionContext): T;
}

/**
 * A converter that can reconstruct arbitrary values (not necessarily
 * `FabricInstance`s) from essential state. Used for built-in JS types like
 * `Error` that participate in the serialization protocol but don't implement
 * `FabricInstance`. See Section 1.4.1 of the formal spec.
 */
export interface StorableConverter<T> {
  /**
   * Reconstruct a value from essential state. Nested values in `state`
   * have already been reconstructed by the serialization system.
   */
  [RECONSTRUCT](state: FabricValue, context: ReconstructionContext): T;
}

/**
 * The minimal interface that `[RECONSTRUCT]` implementations may depend on.
 * Provided by the `Runtime` in practice, but defined as an interface here to
 * avoid a circular dependency between the storable protocol and the runner.
 * See Section 2.5 of the formal spec.
 */
export interface ReconstructionContext {
  /** Resolve a cell reference. Used by types that need to intern or look up
   *  existing instances during reconstruction. */
  getCell(
    ref: { id: string; path: string[]; space: string },
  ): FabricInstance;
}

/**
 * Type guard: checks whether a value implements the storable protocol.
 * See Section 2.6 of the formal spec.
 */
export function isFabricInstance(value: unknown): value is FabricInstance {
  return value instanceof FabricInstance;
}

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
  encode(value: FabricValue): SerializedForm;

  /** Decode a serialized form back into a storable value. */
  decode(
    data: SerializedForm,
    runtime: ReconstructionContext,
  ): FabricValue;
}
