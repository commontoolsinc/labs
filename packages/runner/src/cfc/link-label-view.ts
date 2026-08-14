/**
 * The `cfcLabelView` side-channel that rides on a cell link's inner: the two
 * accessors for the view on a single link, and the two walks that rewrite
 * every view in a whole value.
 *
 * A view is display state rather than part of what a link addresses, and that
 * is what makes the two directions different rather than symmetric. Outbound,
 * the view may be shown but the caveat sources behind it may not, so a value
 * on its way to the main thread is rewritten rather than withheld. Inbound, a
 * view is an untrusted artifact that must not become worker label state, so it
 * is removed outright.
 */

import {
  isLinkRef,
  linkRefFrom,
  linkRefPayload,
} from "@commonfabric/data-model/cell-rep";
import {
  FabricInstance,
  FabricPrimitive,
} from "@commonfabric/data-model/fabric-value";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { refuseFabricInstance } from "../fabric-special-object.ts";
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

/**
 * Helper for the two transforms above, which rebuilds a value with each sigil
 * link's `cfcLabelView` payload rewritten.
 *
 * It terminates only because what it is given is `convertCellsToLinks` output,
 * where a cycle has already become a back-link. That is a coupling between two
 * files and nothing enforces it.
 *
 * A `FabricPrimitive` comes back as the same instance, correctly: a leaf holds
 * no sigil link for this to rewrite. A `FabricInstance` is refused, since
 * passing one through would leave a view riding a link inside it untouched.
 *
 * TODO(danfuzz): track ancestors here, so this stands on its own rather than on
 * what its callers happen to pass.
 */
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
  // A `FabricPrimitive` is `isObjectOrArray` and leaves ahead of the record branch. It
  // holds no sigil link, so returning it whole is the answer.
  if (value instanceof FabricPrimitive) return value;

  // A `FabricInstance` is refused. Its codec contents can carry a sigil link
  // with a `cfcLabelView` riding it, and those contents are not reachable by
  // property name -- so passing one through leaves that view in place. For
  // `stripSigilCfcLabelViews()` that is the inv-12 Stage 0 boundary failing
  // open: an untrusted view arriving from the main thread survives into worker
  // label state, which is the one thing the strip exists to prevent.
  //
  // Nothing reaches this in production today, de facto rather than by
  // construction: a `FabricError` is ungated and exposed to pattern authors, so
  // what keeps this safe is that nothing yet routes one through this ingress.
  //
  // TODO(danfuzz): descend by codec-mediated traversal into instance state, at
  // which point this becomes a walk rather than a refusal.
  if (value instanceof FabricInstance) {
    refuseFabricInstance(value, "when transforming sigil CFC label views");
  }

  if (isObjectOrArray(value)) {
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
