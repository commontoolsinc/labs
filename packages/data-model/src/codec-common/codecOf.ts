import type { FabricSpecialObject } from "@/interface.ts";
import {
  CODEC,
  type FabricClassWithCodec,
  type FabricCodec,
} from "./interface.ts";

/**
 * Gets the `[CODEC]` for the given value's class. Throws a "shouldn't happen"
 * error if the value's class has no `[CODEC]`.
 *
 * A `FabricPrimitive` binds its codec per wire format, under that format's own
 * symbol, so it has no `[CODEC]` and throws here. Reach for `jsonCodecOf()`
 * when the JSON codec is what is wanted, whichever symbol carries it.
 */
export function codecOf(value: FabricSpecialObject): FabricCodec {
  const codec =
    (value.constructor as unknown as Partial<FabricClassWithCodec>)[CODEC];

  if (codec === undefined) {
    throw new Error(
      `Shouldn't happen: no \`[CODEC]\` for \`${value.constructor.name}\`.`,
    );
  }

  return codec;
}
