/**
 * The primitive classes' entry point, and the two facts that have to be kept
 * in step with the set of them: which classes travel over the wire, and which
 * class each name in the schema `type` vocabulary stands for.
 *
 * The list of classes is written out by hand rather than derived, because it
 * cannot be discovered by reflection. A class binds its codec under a wire
 * format's own symbol, so nothing here can name the symbol to look for without
 * naming a format. Adding a primitive therefore means editing this file, and
 * the list is built to fail loudly when it has not been. Everything else here
 * that ranges over the classes is derived from that list. The tag
 * vocabularies that range over them are in `interface.ts`, and the schema
 * `type` vocabulary is in `api.ts`.
 */

import { backtickQuote } from "@commonfabric/utils/markdown";

import type { FabricPrimitiveSchemaType } from "@/api.ts";

import { FabricBytes } from "./FabricBytes.ts";
import { FabricEpochDay } from "./FabricEpochDay.ts";
import { FabricEpochNsec } from "./FabricEpochNsec.ts";
import { FabricHash } from "./FabricHash.ts";
import { FabricKeyPair } from "./FabricKeyPair.ts";
import { FabricRegExp } from "./FabricRegExp.ts";
import { FabricUnavailable } from "./FabricUnavailable.ts";

export { FabricBytes } from "./FabricBytes.ts";
export { FabricRegExp } from "./FabricRegExp.ts";
export { FabricHash } from "./FabricHash.ts";
export { FabricKeyPair } from "./FabricKeyPair.ts";
export { FabricEpochNsec } from "./FabricEpochNsec.ts";
export { FabricEpochDay } from "./FabricEpochDay.ts";
export {
  FabricUnavailable,
  UNAVAILABLE_ERROR_KINDS,
  UNAVAILABLE_PENDING,
  UNAVAILABLE_REASONS,
  UNAVAILABLE_SYNCING,
} from "./FabricUnavailable.ts";

/**
 * The concrete primitive classes whose instances are available over the wire,
 * each via the codec it binds under a wire format's own symbol. This is the
 * curated source of truth for which primitive types participate in encoding:
 * add a class here once it binds a codec for every format that is built.
 *
 * Typed by class and not by codec, which is weaker than it looks: a
 * `FabricPrimitive` binds its codec under a wire format's own symbol, so a
 * type saying which symbol would name a format, and this list is meant to
 * serve all of them.
 * A class here that binds no codec for the format in play is refused by
 * `CodecRegistry.registerClass()` when a registry is built.
 *
 * Returned frozen so callers cannot mutate the shared list.
 */
export function codecClasses(): readonly FabricPrimitiveClass[] {
  return CODEC_CLASSES;
}

/**
 * Returns the concrete primitive class whose instances report `type` as their
 * `.schemaType`. This is the inverse of reading `.schemaType` off an instance,
 * and is what ranges over the classes by name without listing them.
 *
 * @throws If no class reports `type`, which its declared type rules out.
 */
export function fabricPrimitiveClassOfSchemaType(
  type: FabricPrimitiveSchemaType,
): FabricPrimitiveClass {
  const result = CLASS_OF_SCHEMA_TYPE.get(type);
  if (result === undefined) {
    throw new Error(
      "Shouldn't happen: No `FabricPrimitive` class has schema type " +
        `${backtickQuote(type)}.`,
    );
  }
  return result;
}

const CODEC_CLASSES = Object.freeze(
  [
    FabricBytes,
    FabricHash,
    FabricKeyPair,
    FabricEpochNsec,
    FabricEpochDay,
    FabricRegExp,
    FabricUnavailable,
  ] as const,
);

/**
 * One of the concrete primitive classes, as a class rather than an instance
 * of one. `schema-types-agreement.ts` stops compiling when the names these
 * report as `.schemaType` and `FabricPrimitiveSchemaType` stop agreeing, or
 * when two of these report the same name.
 */
export type FabricPrimitiveClass = typeof CODEC_CLASSES[number];

// Each name is read off its class's `prototype`. The contract of `.schemaType`
// is what makes that sound: the getter reads no instance state.
const CLASS_OF_SCHEMA_TYPE: ReadonlyMap<string, FabricPrimitiveClass> = new Map(
  CODEC_CLASSES.map((cls) => [cls.prototype.schemaType, cls]),
);
