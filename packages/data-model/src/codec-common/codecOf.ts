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
 * symbol, so it has no `[CODEC]`. Name that symbol as `altCodec` to reach it;
 * a caller wanting the JSON codec passes `[JSON_CODEC]`. Absent both, this
 * throws.
 *
 * The alternative arrives as a parameter rather than being known here, which
 * is what keeps this module from naming any wire format.
 *
 * @param value The value whose class's codec is wanted.
 * @param altCodec Symbol to try when `[CODEC]` is absent.
 */
export function codecOf(
  value: FabricSpecialObject,
  altCodec?: symbol,
): FabricCodec {
  const cls = value.constructor as unknown as
    & Partial<FabricClassWithCodec>
    & Partial<Record<symbol, FabricCodec>>;
  const codec = cls[CODEC] ??
    ((altCodec === undefined) ? undefined : cls[altCodec]);

  if (codec === undefined) {
    throw new Error(
      `Shouldn't happen: no \`[CODEC]\` for \`${value.constructor.name}\`.`,
    );
  }

  return codec;
}
