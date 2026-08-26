import type { FabricPrimitiveSchemaType } from "@commonfabric/api";
import {
  FabricBytes,
  FabricEpochDay,
  FabricEpochNsec,
  FabricHash,
  FabricKeyPair,
  FabricRegExp,
} from "@commonfabric/data-model/fabric-primitives";
import type { FabricPrimitive } from "@commonfabric/data-model/fabric-value";
import { backtickQuote } from "@commonfabric/utils/markdown";

/**
 * The `type` name in this system's schema dialect for a `FabricPrimitive`
 * instance. This is the value-side counterpart of the api package's
 * `FABRIC_PRIMITIVE_SCHEMA_TYPES` vocabulary: schema validation compares the
 * name returned here against a schema's `type`. The mapping is explicit
 * (`instanceof` per class) rather than derived from `constructor.name`, which
 * minified bundles do not preserve (the shell's production build minifies
 * identifiers; see `packages/shell/felt.config.ts`).
 *
 * Uses "death before confusion": a `FabricPrimitive` subclass missing from
 * this mapping throws rather than degrade to a broader type, so adding a new
 * primitive class forces the vocabulary (here, in `@commonfabric/api`, and in
 * the data-model package's `codecClasses()`) to be extended in the same
 * change.
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
