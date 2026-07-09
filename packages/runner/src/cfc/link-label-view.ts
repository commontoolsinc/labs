import {
  isLinkRef,
  linkRefFrom,
  linkRefPayload,
} from "@commonfabric/data-model/cell-rep";
import { isRecord } from "@commonfabric/utils/types";
import type { CellLinkRefPayload, SigilLink } from "../sigil-types.ts";
import type { CfcLabelView } from "./label-view-core.ts";
import { redactCaveatSourcesForDisplay } from "./label-view-core.ts";

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
  return (linkRefPayload(link) as CfcCellLinkRefPayload).cfcLabelView;
}

/** Attaches a CFC label view to a sigil link's inner, in place. */
export function setLinkCfcLabelView(
  link: SigilLink,
  view: CfcLabelView,
): void {
  (linkRefPayload(link) as CfcCellLinkRefPayload).cfcLabelView = view;
}

/**
 * Redact `Caveat.source` identities from every `cfcLabelView` riding a sigil
 * link inside a main-thread-facing response value (inv-12 Stage 0 / SC-14 /
 * SC-25) — the same display redaction `redactCaveatSourcesForDisplay` applies
 * to the top-level `cfcLabel` at the three IPC response sites, extended to
 * the in-value view copies that `convertCellsToLinks(..., { includeCfcLabelView:
 * true })` attaches.
 *
 * Safe only because the worker no longer consumes inbound views: the persist
 * seam re-derives link-origin labels from stored source metadata, and the IPC
 * ingress does not forward ref-carried views — so a redacted copy that
 * round-trips can never persist as an under-labeled entry. Display-only, like
 * its top-level sibling: enforcement paths read unredacted views through the
 * worker's own seams.
 *
 * Copy-on-write: unchanged subtrees are returned by reference (converted
 * response values can be large; the common labelless case allocates nothing).
 * Input trees are link-converted response values, so they are acyclic.
 */
export function redactSigilCfcLabelViewsForDisplay(value: unknown): unknown {
  return transformSigilCfcLabelViews(value, (payload) => ({
    ...payload,
    cfcLabelView: redactCaveatSourcesForDisplay(payload.cfcLabelView!),
  }));
}

/**
 * Remove every `cfcLabelView` riding a sigil link inside an INBOUND value
 * (inv-12 Stage 0): views arriving from the main thread are untrusted display
 * artifacts and must not become worker label state or link-write policy
 * inputs. `cellRefToSigilLink` already refuses to forward ref-carried views,
 * but raw sigil links bypass the CellRef path — hand-crafted JSON in write
 * values, and CellHandles serialized into `CustomEvent.detail` via `toJSON`
 * re-entering through the VDOM event ingress (codex/cubic review on the
 * Stage 0 PR). Same copy-on-write discipline as the display redactor above.
 */
export function stripSigilCfcLabelViews(value: unknown): unknown {
  return transformSigilCfcLabelViews(value, (payload) => {
    const { cfcLabelView: _cfcLabelView, ...clean } = payload;
    return clean;
  });
}

function transformSigilCfcLabelViews(
  value: unknown,
  transformPayload: (
    payload: CfcCellLinkRefPayload,
  ) => CfcCellLinkRefPayload,
): unknown {
  if (isLinkRef(value)) {
    const payload = linkRefPayload(
      value as SigilLink,
    ) as CfcCellLinkRefPayload;
    if (payload.cfcLabelView === undefined) {
      return value;
    }
    return linkRefFrom<CfcCellLinkRefPayload>(transformPayload(payload));
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = transformSigilCfcLabelViews(item, transformPayload);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (isRecord(value)) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const next = transformSigilCfcLabelViews(item, transformPayload);
      if (next !== item) changed = true;
      out[key] = next;
    }
    return changed ? out : value;
  }
  return value;
}
