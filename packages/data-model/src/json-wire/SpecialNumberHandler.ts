import type { FabricValue } from "../interface.ts";
import type { ReconstructionContext } from "../wire-common/interface.ts";
import { WIRE_TYPE_TAGS } from "../wire-common/wire-type-tags.ts";
import type {
  JsonWireValue,
  TypeHandler,
  TypeHandlerCodec,
} from "./interface.ts";
import { ProblematicValue } from "../fabric-instances/ProblematicValue.ts";

/**
 * Handler for the four "special" numeric values that JSON cannot represent
 * faithfully: `-0`, `NaN`, `+Infinity`, and `-Infinity`. Wire format:
 * `{ "/SpecialNumber@1": "<literal>" }`, where `<literal>` is one of `-0`,
 * `NaN`, `+Infinity`, or `-Infinity`.
 *
 * String state (rather than a JSON number) is used because `JSON.stringify`
 * emits `null` for `NaN`/`±Infinity` and drops the sign on `-0`, which would
 * make a numeric-state form lossy through the JSON layer.
 *
 * Any NaN bit pattern serializes as the literal `"NaN"` and round-trips
 * back to `Number.NaN`.
 */
export const SpecialNumberHandler: TypeHandler = {
  /** @inheritDoc */
  get classSource() {
    return Number;
  },

  /** @inheritDoc */
  get wireTypeTag() {
    return WIRE_TYPE_TAGS.SpecialNumber;
  },

  canSerialize(value: FabricValue): boolean {
    if (typeof value !== "number") return false;
    return Number.isNaN(value) ||
      value === Infinity ||
      value === -Infinity ||
      Object.is(value, -0);
  },

  serialize(
    value: FabricValue,
    codec: TypeHandlerCodec,
    _recurse: (v: FabricValue) => JsonWireValue,
  ): JsonWireValue {
    const num = value as number;
    let state: string;
    if (Number.isNaN(num)) {
      state = "NaN";
    } else if (num === Infinity) {
      state = "+Infinity";
    } else if (num === -Infinity) {
      state = "-Infinity";
    } else {
      // The remaining canSerialize case is `Object.is(num, -0)`.
      state = "-0";
    }
    return codec.wrapTag(WIRE_TYPE_TAGS.SpecialNumber, state);
  },

  deserialize(
    state: JsonWireValue,
    _runtime: ReconstructionContext,
    _recurse: (v: JsonWireValue) => FabricValue,
  ): FabricValue {
    if (typeof state !== "string") {
      return new ProblematicValue(
        WIRE_TYPE_TAGS.SpecialNumber,
        state,
        `SpecialNumber: expected string state, got ${typeof state}`,
      );
    }
    switch (state) {
      case "-0":
        return -0;
      case "+Infinity":
        return Infinity;
      case "-Infinity":
        return -Infinity;
      case "NaN":
        return NaN;
      default:
        return new ProblematicValue(
          WIRE_TYPE_TAGS.SpecialNumber,
          state,
          `SpecialNumber: unknown literal ${JSON.stringify(state)}`,
        );
    }
  },
};
