import type { FabricSpecialObject } from "@/interface.ts";
import {
  CODEC,
  type FabricClassWithCodec,
  type FabricCodec,
} from "./interface.ts";

/**
 * Gets the `[CODEC]` for the given value's class. Analogous to
 * `BaseFabricInstance.wireTypeTagOf()` (which returns the wire type tag), but
 * returns the codec instead. Throws a "shouldn't happen" error if the value's
 * class has no `[CODEC]`.
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
