import {
  DECONSTRUCT,
  FabricInstance,
  type FabricValue,
  type ReconstructionContext,
} from "../interface.ts";
import { ExplicitTagValue } from "../fabric-instances/ExplicitTagValue.ts";
import type {
  JsonWireValue,
  TypeHandler,
  TypeHandlerCodec,
} from "./interface.ts";

/**
 * Handler for `FabricInstance` values (custom protocol types, including
 * `FabricError` and `ExplicitTagValue` subtypes). Serializes via
 * `[DECONSTRUCT]` and the codec's tag methods. Deserialization is not
 * dispatched via this handler's tag (since each instance type has its own tag
 * like `WIRE_TYPE_TAGS.Error`); instead, the deserializer falls back to the
 * class registry for those tags.
 */
export const FabricInstanceHandler: TypeHandler = {
  /**
   * This tag is not used for deserialization dispatch: `FabricInstance`
   * types are looked up by their individual tags. The handler is registered
   * for serialization matching only.
   */
  get wireTypeTag() {
    return undefined;
  },

  canSerialize(value: FabricValue): boolean {
    return value instanceof FabricInstance;
  },

  serialize(
    value: FabricValue,
    codec: TypeHandlerCodec,
    recurse: (v: FabricValue) => JsonWireValue,
  ): JsonWireValue {
    const inst = value as FabricInstance;

    // For `ExplicitTagValue`, use the preserved original `wireTypeTag` and
    // `state`.
    if (inst instanceof ExplicitTagValue) {
      const serializedState = recurse(inst.state);
      return codec.wrapTag(inst.wireTypeTag, serializedState);
    }

    // General `FabricInstance`: use `[DECONSTRUCT]` and codec for tag.
    const state = inst[DECONSTRUCT]();
    const tag = codec.getTagFor(inst);
    const serializedState = recurse(state);
    return codec.wrapTag(tag, serializedState);
  },

  deserialize(
    _state: JsonWireValue,
    _runtime: ReconstructionContext,
    _recurse: (v: JsonWireValue) => FabricValue,
  ): FabricValue {
    // Not reached via tag dispatch -- `FabricInstance` deserialization is
    // handled by the class registry fallback in `deserialize()`.
    throw new Error("FabricInstanceHandler.deserialize should not be called");
  },
};
