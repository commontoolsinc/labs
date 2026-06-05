import type { FabricInstance, FabricValue } from "../interface.ts";
import type {
  FabricDeconstructable,
  ReconstructionContext,
} from "../wire-common/interface.ts";

/**
 * JSON-compatible wire format value. This is the intermediate tree
 * representation used during serialization tree walking -- NOT the final
 * serialized form (which is `string`). Internal to the JSON implementation.
 *
 * Deep-frozen invariant: every wire tree that *enters deserialization* is
 * deep-frozen. This is enforced at the two construction sites that feed
 * `deserialize()` -- `decode()` and `fromBytes()`, unified in
 * `#parseWireText()` -- and is what lets `unwrapTag()` / the `/quote` arm
 * hand back extracted sub-trees directly (see their contracts). The transient
 * trees built on the *serialize* side are not covered by this invariant: they
 * are `JSON.stringify`-ed and discarded by `encode()` / `encodeToBytes()` and
 * never reach a caller. (The serialize-side `/quote` form happens to be
 * deep-frozen as a side effect of `unquote()`'s recursive rebuild, but no
 * other serialize output is, and none needs to be.)
 */
export type JsonWireValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonWireValue[]
  | { readonly [key: string]: JsonWireValue };

/**
 * Narrow interface for what type handlers need from the encoding context
 * during tree walking. Contains only the tag-wrapping and tag-lookup methods
 * needed by handler serialize/deserialize implementations.
 *
 * This is NOT a public interface -- it exists to type the `codec` parameter
 * passed to type handlers by the internal tree-walking engine.
 */
export interface TypeHandlerCodec {
  /** Wraps a tag and state into the wire format's tagged representation. */
  wrapTag(tag: string, state: JsonWireValue): JsonWireValue;
  /** Returns the wire format tag for a fabric instance's type. */
  getTagFor(value: FabricInstance | FabricDeconstructable): string;
}

/**
 * Interface for per-type serialize/deserialize handlers. Each handler knows
 * how to serialize values of its type and how to deserialize them from a
 * specific tag. Handlers are registered in a `TypeHandlerRegistry`.
 * See Section 4.5 of the formal spec.
 */
export interface TypeHandler {
  /**
   * The unique class (constructor function) whose direct instances this handler
   * serializes from, if any. This _can_ be the non-`new`-able "constructor"
   * function for a primitive type (e.g., `BigInt`). If a handler is found to
   * match on this, it will still be asked `canSerialize()` to handle the case
   * of a handler for _some_ but not _all_ values of a particular class/type.
   *
   * **Note:** If this is a base class, this will not cause its subclasses to be
   * matched.
   */
  get classSource(): ((...args: any[]) => any) | undefined;

  /**
   * The unique wire format tag this handler deserializes from, if any.
   */
  get wireTypeTag(): string | undefined;

  /**
   * Returns `true` if this handler can serialize the given value. Called
   * during serialization to find a compatible handler.
   */
  canSerialize(value: FabricValue): boolean;

  /**
   * Serializes the value. Only called after `canSerialize()` returned `true`.
   * The handler is responsible for tag wrapping via `codec.wrapTag()` and for
   * recursively serializing nested values via the provided `recurse` callback.
   */
  serialize(
    value: FabricValue,
    codec: TypeHandlerCodec,
    recurse: (v: FabricValue) => JsonWireValue,
  ): JsonWireValue;

  /**
   * Deserializes a value from its wire format state. The state has already been
   * unwrapped (tag stripped) but inner values have NOT been recursively
   * deserialized -- the handler must call `recurse` on nested values.
   */
  deserialize(
    state: JsonWireValue,
    runtime: ReconstructionContext,
    recurse: (v: JsonWireValue) => FabricValue,
  ): FabricValue;
}
