import type { FabricSpecialObject } from "@/interface.ts";
import {
  CODEC,
  type FabricClassWithCodec,
  type FabricCodec,
} from "@/codec-common/interface.ts";
import {
  type FabricPrimitiveClassWithJsonCodec,
  JSON_CODEC,
} from "@/fabric-primitives/BaseFabricPrimitive.ts";

/**
 * Gets the codec that encodes the given value for the JSON wire format.
 *
 * Two symbols, because the two kinds of value bind differently. A
 * `FabricPrimitive` terminates an encoding, so it binds one codec per format
 * under that format's own symbol -- `[JSON_CODEC]` here. A `FabricInstance`
 * only decomposes, so one `[CODEC]` serves every format and is what this falls
 * back to.
 *
 * Unlike `codecOf()`, this never legitimately comes up empty: a primitive
 * binds `[JSON_CODEC]` and an instance binds `[CODEC]`, so neither being
 * present is a "shouldn't happen" and throws. A caller that wants the
 * format-neutral codec, and so should see `undefined` for a primitive, wants
 * `codecOf()` instead.
 *
 * @throws If the value's class binds neither symbol.
 */
export function jsonCodecOf(value: FabricSpecialObject): FabricCodec {
  const cls = value.constructor as unknown as
    & Partial<FabricPrimitiveClassWithJsonCodec>
    & Partial<FabricClassWithCodec>;
  const codec = cls[JSON_CODEC] ?? cls[CODEC];

  if (codec === undefined) {
    throw new Error(
      `Shouldn't happen: no \`[JSON_CODEC]\` or \`[CODEC]\` for ` +
        `\`${value.constructor.name}\`.`,
    );
  }

  return codec;
}
