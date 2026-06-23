import type { FabricClassWithCodec } from "@/codec-common/interface.ts";
import { FabricError } from "./FabricError.ts";
import { FabricLink } from "./FabricLink.ts";
import { FabricMap } from "./FabricMap.ts";
import { FabricSet } from "./FabricSet.ts";
import { ProblematicValue } from "./ProblematicValue.ts";
import { UnknownValue } from "./UnknownValue.ts";

export { BaseFabricInstance } from "./BaseFabricInstance.ts";
export { ExplicitTagValue } from "./ExplicitTagValue.ts";
export { ProblematicValue } from "./ProblematicValue.ts";
export { UnknownValue } from "./UnknownValue.ts";
export { FabricNativeWrapper } from "./FabricNativeWrapper.ts";
export { FabricError, type FabricErrorState } from "./FabricError.ts";
export { FabricLink, type FabricLinkPayload } from "./FabricLink.ts";
export { FabricMap } from "./FabricMap.ts";
export { FabricSet } from "./FabricSet.ts";

/**
 * The concrete instance classes whose instances are available over the wire,
 * each via its static `[CODEC]`. This is the curated source of truth for which
 * instance types participate in serialization.
 *
 * `UnknownValue` / `ProblematicValue` (the `ExplicitTagValue` subclasses) are
 * included too. Their codecs have no preferred wire tag -- the encode path uses
 * `tagForValue()` to read each instance's preserved per-instance tag -- and
 * they are not tag-routed on decode (an unrecognized tag is wrapped in an
 * `UnknownValue` by the encoding context, not decoded via a codec).
 *
 * Returned frozen so callers cannot mutate the shared list.
 */
export function codecClasses(): readonly FabricClassWithCodec[] {
  return CODEC_CLASSES;
}

const CODEC_CLASSES: readonly FabricClassWithCodec[] = Object.freeze([
  FabricError,
  FabricLink,
  FabricMap,
  FabricSet,
  ProblematicValue,
  UnknownValue,
]);
