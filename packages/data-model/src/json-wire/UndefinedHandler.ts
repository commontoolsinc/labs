import type { FabricValue, ReconstructionContext } from "../interface.ts";
import { TAGS } from "../fabric-type-tags.ts";
import type {
  JsonWireValue,
  TypeHandler,
  TypeHandlerCodec,
} from "./json-wire-types.ts";

/**
 * Handler for `undefined`. Serializes to `TAGS.Undefined` tag with `null`
 * state. See Section 1.4.1 of the formal spec.
 */
export const UndefinedHandler: TypeHandler = {
  tag: TAGS.Undefined,

  canSerialize(value: FabricValue): boolean {
    return value === undefined;
  },

  serialize(
    _value: FabricValue,
    codec: TypeHandlerCodec,
    _recurse: (v: FabricValue) => JsonWireValue,
  ): JsonWireValue {
    return codec.wrapTag(TAGS.Undefined, null);
  },

  deserialize(
    _state: JsonWireValue,
    _runtime: ReconstructionContext,
    _recurse: (v: JsonWireValue) => FabricValue,
  ): FabricValue {
    return undefined;
  },
};
