import type { FabricValue } from "@/interface.ts";
import type { ReconstructionContext } from "@/wire-common/interface.ts";
import { WIRE_TYPE_TAGS } from "@/wire-common/wire-type-tags.ts";
import type { JsonWireValue, TagHandler, TypeHandler } from "./interface.ts";

/**
 * Handler for `undefined`. Serializes to `WIRE_TYPE_TAGS.Undefined` tag with
 * `null` state. See Section 1.4.1 of the formal spec.
 */
export const UndefinedHandler: TypeHandler = {
  /**
   * `undefined` doesn't have a corresponding class, so this is `undefined` and
   * not a would-be `Undefined`.
   */
  get classSource() {
    return undefined;
  },

  /** @inheritDoc */
  get wireTypeTag() {
    return WIRE_TYPE_TAGS.Undefined;
  },

  canSerialize(value: FabricValue): boolean {
    return value === undefined;
  },

  serialize(
    _value: FabricValue,
    tagHandler: TagHandler,
    _recurse: (v: FabricValue) => JsonWireValue,
  ): JsonWireValue {
    return tagHandler.wrapTag(WIRE_TYPE_TAGS.Undefined, null);
  },

  deserialize(
    _state: JsonWireValue,
    _runtime: ReconstructionContext,
    _recurse: (v: JsonWireValue) => FabricValue,
  ): FabricValue {
    return undefined;
  },
};
