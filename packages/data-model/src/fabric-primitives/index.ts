import { backtickQuote } from "@commonfabric/utils/markdown";
import type { FabricPrimitiveSchemaType } from "@commonfabric/api";

import type { FabricPrimitive } from "@/interface.ts";
import type { FabricCodec } from "@/codec-common/interface.ts";
import type { JsonCodecValue } from "@/codec-json/interface.ts";
import { JSON_CODEC } from "@/interface.ts";
import type { FabricClassWithJsonCodec } from "./BaseFabricPrimitive.ts";
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
 * each via its static `[JSON_CODEC]`. This is the curated source of truth for
 * which primitive types participate in serialization: add a class here once it
 * gains a `[JSON_CODEC]`.
 *
 * Returned frozen so callers cannot mutate the shared list.
 */
export function codecClasses(): readonly FabricClassWithJsonCodec[] {
  return CODEC_CLASSES;
}

/**
 * The JSON codecs of {@link codecClasses}, in the same order. This is what a
 * registry wants: reading `[JSON_CODEC]` is the business of the module that
 * knows these classes bind it, not of every caller assembling a registry.
 *
 * Returned frozen so callers cannot mutate the shared list.
 */
export function jsonCodecs(): readonly FabricCodec<JsonCodecValue>[] {
  return JSON_CODECS;
}

const CODEC_CLASSES: readonly FabricClassWithJsonCodec[] = Object.freeze([
  FabricBytes,
  FabricHash,
  FabricEpochNsec,
  FabricEpochDays,
  FabricRegExp,
]);

const JSON_CODECS: readonly FabricCodec<JsonCodecValue>[] = Object.freeze(
  CODEC_CLASSES.map((cls) => cls[JSON_CODEC]),
);

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
