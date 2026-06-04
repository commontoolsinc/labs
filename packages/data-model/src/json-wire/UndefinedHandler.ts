import type { FabricValue, ReconstructionContext } from "../interface.ts";
import { WIRE_TYPE_TAGS } from "../wire-common/wire-type-tags.ts";
import type {
  JsonWireValue,
  TypeHandler,
  TypeHandlerCodec,
} from "./interface.ts";

/**
 * Handler for `undefined`. Serializes to `WIRE_TYPE_TAGS.Undefined` tag with
 * `null` state. See Section 1.4.1 of the formal spec.
 */
export const UndefinedHandler: TypeHandler = {
  get wireTypeTag(): string {
    return WIRE_TYPE_TAGS.Undefined;
  },

  canSerialize(value: FabricValue): boolean {
    return value === undefined;
  },

  serialize(
    _value: FabricValue,
    codec: TypeHandlerCodec,
    _recurse: (v: FabricValue) => JsonWireValue,
  ): JsonWireValue {
    return codec.wrapTag(WIRE_TYPE_TAGS.Undefined, null);
  },

  deserialize(
    _state: JsonWireValue,
    _runtime: ReconstructionContext,
    _recurse: (v: JsonWireValue) => FabricValue,
  ): FabricValue {
    return undefined;
  },
};
