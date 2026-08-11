import { backtickQuote } from "@commonfabric/utils/markdown";

import type { FabricPrimitiveClassWithJsonCodec } from "./BaseFabricPrimitive.ts";
import type { FabricPrimitiveSchemaType } from "@commonfabric/api";

import type { FabricPrimitive } from "@/interface.ts";
import { FabricBytes } from "./FabricBytes.ts";
import { FabricEpochDays } from "./FabricEpochDays.ts";
import { FabricEpochNsec } from "./FabricEpochNsec.ts";
import { FabricHash } from "./FabricHash.ts";
import { FabricRegExp } from "./FabricRegExp.ts";

export { BaseFabricPrimitive } from "./BaseFabricPrimitive.ts";
export { FabricBytes } from "./FabricBytes.ts";
export { FabricRegExp } from "./FabricRegExp.ts";
export { FabricHash } from "./FabricHash.ts";
export { FabricEpochNsec } from "./FabricEpochNsec.ts";
export { FabricEpochDays } from "./FabricEpochDays.ts";

/**
 * The concrete primitive classes whose instances are available over the wire,
 * each via its static `[JSON_CODEC]`. This is the curated source of truth for which
 * primitive types participate in serialization: add a class here once it gains
 * a `[JSON_CODEC]`.
 *
 * Returned frozen so callers cannot mutate the shared list.
 */
export function codecClasses(): readonly FabricPrimitiveClassWithJsonCodec[] {
  return CODEC_CLASSES;
}

const CODEC_CLASSES: readonly FabricPrimitiveClassWithJsonCodec[] = Object
  .freeze([
    FabricBytes,
    FabricHash,
    FabricEpochNsec,
    FabricEpochDays,
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
  if (value instanceof FabricEpochDays) return "FabricEpochDays";
  if (value instanceof FabricEpochNsec) return "FabricEpochNsec";
  if (value instanceof FabricHash) return "FabricHash";
  if (value instanceof FabricRegExp) return "FabricRegExp";
  throw new Error(
    `Shouldn't happen: \`FabricPrimitive\` subclass without a schema type ` +
      `name: ${backtickQuote(value.constructor.name)}. Add it to ` +
      "`schemaTypeOfFabricPrimitive()` and `FABRIC_PRIMITIVE_SCHEMA_TYPES`.",
  );
}
