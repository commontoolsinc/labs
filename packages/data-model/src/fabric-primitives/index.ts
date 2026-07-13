import type { FabricClassWithCodec } from "@/codec-common/interface.ts";
import { FabricBytes } from "./FabricBytes.ts";
import { FabricEpochDays } from "./FabricEpochDays.ts";
import { FabricEpochNsec } from "./FabricEpochNsec.ts";
import { FabricHash } from "./FabricHash.ts";
import { FabricRegExp } from "./FabricRegExp.ts";

export { BaseFabricPrimitive } from "./BaseFabricPrimitive.ts";
export {
  COMPUTED_URI_SCHEME,
  type EntityKind,
  entityKindOfIdString,
  getComputedCellIdsConfig,
  getComputedDropPolicyConfig,
  isEntityKind,
  resetComputedCellIdsConfig,
  resetComputedDropPolicyConfig,
  setComputedCellIdsConfig,
  setComputedDropPolicyConfig,
  uriSchemeForEntityKind,
} from "./entity-kind.ts";
export { FabricBytes } from "./FabricBytes.ts";
export { FabricRegExp } from "./FabricRegExp.ts";
export { FabricHash } from "./FabricHash.ts";
export { FabricEpochNsec } from "./FabricEpochNsec.ts";
export { FabricEpochDays } from "./FabricEpochDays.ts";

/**
 * The concrete primitive classes whose instances are available over the wire,
 * each via its static `[CODEC]`. This is the curated source of truth for which
 * primitive types participate in serialization: add a class here once it gains
 * a `[CODEC]`.
 *
 * Returned frozen so callers cannot mutate the shared list.
 */
export function codecClasses(): readonly FabricClassWithCodec[] {
  return CODEC_CLASSES;
}

const CODEC_CLASSES: readonly FabricClassWithCodec[] = Object.freeze([
  FabricBytes,
  FabricHash,
  FabricEpochNsec,
  FabricEpochDays,
  FabricRegExp,
]);
