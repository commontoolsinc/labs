/**
 * The primitive classes' entry point, and the answer that has to be kept in
 * step with the set of them: which classes travel over the wire.
 *
 * That list is written out by hand rather than derived, because it cannot be
 * discovered by reflection. A class binds its codec under a wire format's own
 * symbol, so nothing here can name the symbol to look for without naming a
 * format. Adding a primitive therefore means editing this file, and the list
 * is built to fail loudly when it has not been.
 */

import type { Constructor } from "@commonfabric/utils/types";

import { FabricBytes } from "./FabricBytes.ts";
import { FabricEpochDay } from "./FabricEpochDay.ts";
import { FabricEpochNsec } from "./FabricEpochNsec.ts";
import { FabricHash } from "./FabricHash.ts";
import { FabricKeyPair } from "./FabricKeyPair.ts";
import { FabricRegExp } from "./FabricRegExp.ts";

export { FabricBytes } from "./FabricBytes.ts";
export { FabricRegExp } from "./FabricRegExp.ts";
export { FabricHash } from "./FabricHash.ts";
export { FabricKeyPair } from "./FabricKeyPair.ts";
export { FabricEpochNsec } from "./FabricEpochNsec.ts";
export { FabricEpochDay } from "./FabricEpochDay.ts";

/**
 * The concrete primitive classes whose instances are available over the wire,
 * each via the codec it binds under a wire format's own symbol. This is the
 * curated source of truth for which primitive types participate in encoding:
 * add a class here once it binds a codec for every format that is built.
 *
 * Typed only as classes, which is weaker than it looks: a `FabricPrimitive`
 * binds its codec under a wire format's own symbol, so a type saying which
 * symbol would name a format, and this list is meant to serve all of them.
 * A class here that binds no codec for the format in play is refused by
 * `CodecRegistry.registerClass()` when a registry is built.
 *
 * Returned frozen so callers cannot mutate the shared list.
 */
export function codecClasses(): readonly Constructor[] {
  return CODEC_CLASSES;
}

const CODEC_CLASSES: readonly Constructor[] = Object.freeze([
  FabricBytes,
  FabricHash,
  FabricKeyPair,
  FabricEpochNsec,
  FabricEpochDay,
  FabricRegExp,
]);
