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
 * instance types participate in serialization. (`ExplicitTagValue`'s subclasses
 * `UnknownValue` / `ProblematicValue` are live-graph stand-ins carrying a
 * per-instance tag. They do define a `[CODEC]` -- the source of truth for their
 * `[DECONSTRUCT]` / `[RECONSTRUCT]` form -- but it has no preferred wire tag and
 * is intentionally absent here: the encoding context handles them directly.)
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
