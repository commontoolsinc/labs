/**
 * The primitive classes' entry point, and the two answers that have to be kept
 * in step with the set of them: which classes travel over the wire, and what
 * each one is called in the schema dialect.
 *
 * Both lists are written out by hand rather than derived, because neither can
 * be discovered by reflection. A class binds its codec under a wire format's
 * own symbol, so nothing here can name the symbol to look for without naming a
 * format; and the constructor name a lookup would otherwise key on does not
 * survive a minified build. Adding a primitive therefore means editing this
 * file, and both lists are built to fail loudly when it has not been.
 */

import { backtickQuote } from "@commonfabric/utils/markdown";
import type { Constructor } from "@commonfabric/utils/types";
import type { FabricPrimitiveSchemaType } from "@commonfabric/api";

import type { FabricPrimitive } from "@/interface.ts";
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

/**
 * The `type` name in this system's schema dialect for a `FabricPrimitive`
 * instance, resolved by prototype. This is the value-side counterpart of the
 * api package's `FABRIC_PRIMITIVE_SCHEMA_TYPES` vocabulary: schema validation
 * compares the name returned here against a schema's `type`. The mapping is
 * explicit (`instanceof` per class) rather than derived from
 * `constructor.name`, which minified bundles do not preserve (the shell's
 * production build minifies identifiers; see `packages/shell/felt.config.ts`).
 *
 * Uses "death before confusion": a `FabricPrimitive` subclass missing from
 * this mapping throws rather than degrade to a broader type, so adding a new
 * primitive class forces the vocabulary (here and in `@commonfabric/api`) to
 * be extended in the same change.
 */
export function schemaTypeOfFabricPrimitive(
  value: FabricPrimitive,
): FabricPrimitiveSchemaType {
  if (value instanceof FabricBytes) return "FabricBytes";
  if (value instanceof FabricEpochDay) return "FabricEpochDay";
  if (value instanceof FabricEpochNsec) return "FabricEpochNsec";
  if (value instanceof FabricHash) return "FabricHash";
  if (value instanceof FabricKeyPair) return "FabricKeyPair";
  if (value instanceof FabricRegExp) return "FabricRegExp";
  throw new Error(
    `Shouldn't happen: \`FabricPrimitive\` subclass without a schema type ` +
      `name: ${backtickQuote(value.constructor.name)}. Add it to ` +
      "`schemaTypeOfFabricPrimitive()` and `FABRIC_PRIMITIVE_SCHEMA_TYPES`.",
  );
}
