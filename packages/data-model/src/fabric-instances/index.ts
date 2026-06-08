import type { FabricClassWithCodec } from "@/wire-common/interface.ts";
import { FabricError } from "./FabricError.ts";
import { FabricMap } from "./FabricMap.ts";
import { FabricSet } from "./FabricSet.ts";

export { BaseFabricInstance } from "./BaseFabricInstance.ts";
export { ExplicitTagValue } from "./ExplicitTagValue.ts";
export { ProblematicValue } from "./ProblematicValue.ts";
export { UnknownValue } from "./UnknownValue.ts";
export { FabricNativeWrapper } from "./FabricNativeWrapper.ts";
export { FabricError, type FabricErrorState } from "./FabricError.ts";
export { FabricMap } from "./FabricMap.ts";
export { FabricSet } from "./FabricSet.ts";

/**
 * The concrete instance classes whose instances are available over the wire,
 * each via its static `[CODEC]`. This is the curated source of truth for which
 * instance types participate in serialization: add a class here once it gains
 * a `[CODEC]`. (`ExplicitTagValue` and its subclasses `UnknownValue` /
 * `ProblematicValue` are live-graph stand-ins carrying a per-instance tag,
 * handled directly by the encoding context rather than via a `[CODEC]`, so
 * they are intentionally absent.)
 *
 * Returned frozen so callers cannot mutate the shared list.
 */
export function codecClasses(): readonly FabricClassWithCodec[] {
  return CODEC_CLASSES;
}

const CODEC_CLASSES: readonly FabricClassWithCodec[] = Object.freeze([
  FabricError,
  FabricMap,
  FabricSet,
]);
