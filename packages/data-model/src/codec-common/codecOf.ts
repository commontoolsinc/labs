import type { FabricSpecialObject } from "@/interface.ts";
import {
  CODEC,
  type FabricClassWithCodec,
  type FabricCodec,
} from "./interface.ts";

/**
 * Gets the `[CODEC]` bound to the given value's class, or `undefined` if the
 * class binds none.
 *
 * A `FabricPrimitive` binds no `[CODEC]`, and so answers `undefined` here: its
 * codec terminates an encoding and is therefore bound per wire format, under
 * that format's own symbol. Only a `FabricInstance`, whose codec merely
 * decomposes and so serves every format alike, is reachable this way.
 */
export function codecOf(
  value: FabricSpecialObject,
): FabricCodec | undefined {
  return (value.constructor as unknown as Partial<FabricClassWithCodec>)[CODEC];
}
