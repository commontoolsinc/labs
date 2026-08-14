import type { Constructor } from "@commonfabric/utils/types";

import type { FabricClassWithNonterminalCodec } from "@/codec-interface/interface.ts";
import { FabricError } from "./FabricError.ts";
import { FabricLink } from "./FabricLink.ts";
import { FabricMap } from "./FabricMap.ts";
import { FabricSet } from "./FabricSet.ts";
import { ProblematicValue } from "@/codec-common/ProblematicValue.ts";
import { UnknownValue } from "@/codec-common/UnknownValue.ts";

export { FabricNativeWrapper } from "./FabricNativeWrapper.ts";
export { FabricError, type FabricErrorState } from "./FabricError.ts";
export { FabricLink } from "./FabricLink.ts";
export { FabricMap } from "./FabricMap.ts";
export { FabricSet } from "./FabricSet.ts";

/**
 * A concrete instance class as this roster holds one: a class, and one binding
 * a format-neutral `[CODEC]`. The second half is what a roster of primitives
 * cannot claim, their codecs being bound per format.
 */
type InstanceCodecClass = Constructor & FabricClassWithNonterminalCodec;

/**
 * The concrete instance classes whose instances are available over the wire,
 * each via its static `[CODEC]`. This is the curated source of truth for which
 * instance types participate in serialization.
 *
 * `UnknownValue` and `ProblematicValue` are included too, and their codecs
 * differ from each other. `UnknownValue`'s has no preferred wire tag -- the
 * encode path uses `tagForValue()` to read each instance's preserved
 * per-instance tag -- and it is not tag-routed on decode, an unrecognized tag
 * being wrapped by the encoding context rather than decoded via a codec.
 * `ProblematicValue`'s is ordinary in both respects: it declares
 * `Problematic@1` and is tag-routed like any other, the preserved tag riding
 * inside its state because it need not be a tag at all.
 *
 * Returned frozen so callers cannot mutate the shared list.
 */
export function codecClasses(): readonly InstanceCodecClass[] {
  return CODEC_CLASSES;
}

const CODEC_CLASSES: readonly InstanceCodecClass[] = Object.freeze([
  FabricError,
  FabricLink,
  FabricMap,
  FabricSet,
  ProblematicValue,
  UnknownValue,
]);
