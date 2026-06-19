import { linkRefInner } from "@commonfabric/data-model/cell-rep";
import type { CellLinkRefPayload, SigilLink } from "../sigil-types.ts";
import type { CfcLabelView } from "./label-view-core.ts";

/**
 * A cell-link payload that additionally carries a CFC label view. The label
 * view is a CFC-owned side-channel smuggled on the link inner: producers write
 * it and the flow-control machinery reads it back. Keeping it out of the base
 * {@link CellLinkRefPayload} (and confined to this cfc module) is deliberate —
 * it is not part of the link's addressing identity, and link normalization /
 * equality ignore it.
 */
export type CfcCellLinkRefPayload = CellLinkRefPayload & {
  cfcLabelView?: CfcLabelView;
};

/** Reads the CFC label view carried on a sigil link, if any. */
export function linkCfcLabelView(link: SigilLink): CfcLabelView | undefined {
  return (linkRefInner(link) as CfcCellLinkRefPayload).cfcLabelView;
}

/** Attaches a CFC label view to a sigil link's inner, in place. */
export function setLinkCfcLabelView(
  link: SigilLink,
  view: CfcLabelView,
): void {
  (linkRefInner(link) as CfcCellLinkRefPayload).cfcLabelView = view;
}
