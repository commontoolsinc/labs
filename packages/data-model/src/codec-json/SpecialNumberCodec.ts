import type { FabricValue } from "@/interface.ts";
import { BaseFabricCodec } from "@/codec-common/BaseFabricCodec.ts";
import type { ReconstructionContext } from "@/codec-common/interface.ts";
import { WIRE_TYPE_TAGS } from "@/codec-common/wire-type-tags.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";

/**
 * Codec for the four "special" numeric values that JSON cannot represent
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
export class SpecialNumberCodec extends BaseFabricCodec {
  constructor() {
    super(WIRE_TYPE_TAGS.SpecialNumber, Number);
  }

  /** @inheritDoc */
  override canEncode(value: FabricValue): boolean {
    return typeof value === "number" &&
      (Number.isNaN(value) ||
        value === Infinity ||
        value === -Infinity ||
        Object.is(value, -0));
  }

  /** @inheritDoc */
  encode(value: number): FabricValue {
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "+Infinity";
    if (value === -Infinity) return "-Infinity";
    // The remaining `canEncode` case is `Object.is(value, -0)`.
    return "-0";
  }

  /** @inheritDoc */
  decode(
    typeTag: string,
    state: FabricValue,
    _context: ReconstructionContext,
  ): FabricValue {
    if (typeof state !== "string") {
      return new ProblematicValue(
        typeTag,
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
          typeTag,
          state,
          `SpecialNumber: unknown literal ${JSON.stringify(state)}`,
        );
    }
  }
}
