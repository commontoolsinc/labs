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
 * Gets the codec that encodes the given value for the JSON wire format, or
 * `undefined` if its class provides none.
 *
 * Two symbols, because the two kinds of value bind differently. A
 * `FabricPrimitive` terminates an encoding, so it binds one codec per format
 * under that format's own symbol -- `[JSON_CODEC]` here. A `FabricInstance`
 * only decomposes, so one `[CODEC]` serves every format and is what this falls
 * back to.
 *
 * A caller that wants the format-neutral codec, and so should see `undefined`
 * for a primitive, wants `codecOf()` instead.
 */
export function jsonCodecOf(
  value: FabricSpecialObject,
): FabricCodec | undefined {
  const cls = value.constructor as unknown as
    & Partial<FabricPrimitiveClassWithJsonCodec>
    & Partial<FabricClassWithCodec>;

  return cls[JSON_CODEC] ?? cls[CODEC];
}
