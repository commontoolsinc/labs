// The concerns ledger's view model, and the ordering vocabulary its CSS uses.
//
// The ledger renders ONCE, statically, in the source document's maturity order.
// Sorting and filtering are then presentation: the panel carries one reactive
// class and CSS does the rest — `order` on the flex rows for the layer sort,
// `display:none` for the open-questions filter.
//
// This is not a shortcut around reactivity, it is a workaround for a real
// limitation. Driving the rows from a `computed()` that returns a re-ordered
// array does NOT re-render: the lift re-runs and reports the new data (verified
// live — the mode and row counts update), but `mapWithPattern` keeps the
// original element order on screen. Reordering 115 rows through the reactive
// array is also far more work than toggling one class. The source document
// already filtered this way, with a `.flags-only` class.

import { type Band, BANDS, type ConcernRow } from "./content.ts";

export const FLAG = "⚑";

/**
 * Layer order for the "layer" sort, keyed by the layer's class suffix. This is
 * the single source of truth: `layerOrderCss()` emits the matching CSS, so the
 * rules cannot drift from the vocabulary.
 */
export const LAYER_ORDER: Record<string, number> = {
  edge: 0, // Pattern
  shell: 1, // Shell
  mix: 2, // Mixed
  core: 3, // Fabric
};

/** The class the ledger wrapper carries for each sort mode. */
export const MODE_CLASS: Record<string, string> = {
  maturity: "",
  layer: "by-layer",
  open: "flags-only",
};

export interface RowVM {
  cls: string;
  name: string;
  tip: string;
  layerText: string;
  layerCls: string;
  status: string;
  statusCls: string;
  flag: string;
  flagCls: string;
  flagMark: string;
}

export interface StripVM {
  style: string;
}

export interface DomainVM {
  cls: string;
  title: string;
  flagNote: string;
  strip: StripVM[];
  rows: RowVM[];
}

export interface BandVM {
  cls: string;
  title: string;
  sub: string;
  domains: DomainVM[];
}

const rowVM = (r: ConcernRow): RowVM => ({
  // `lr-*` drives the layer sort, `flagged` drives the open-questions filter.
  cls: "crow lr-" + r.layerCls + (r.flag ? " flagged" : ""),
  name: r.name,
  tip: r.tip ?? "",
  layerText: r.layer,
  layerCls: "clayer l-" + r.layerCls,
  status: r.status,
  statusCls: "cstat s-" + r.status,
  flag: r.flag ?? "",
  flagCls: r.flag ? "cflag" : "",
  flagMark: r.flag ? FLAG : "",
});

const bandVM = (b: Band): BandVM => ({
  cls: "cband l-" + b.layer +
    (b.domains.some((d) => d.flags > 0) ? " flagged" : ""),
  title: b.title,
  sub: b.sub,
  domains: b.domains.map((d) => ({
    cls: d.flags > 0 ? "cdom flagged" : "cdom",
    title: d.title,
    flagNote: d.flags > 0 ? d.flags + " " + FLAG : "",
    strip: d.strip.map((s) => ({
      style: "width:" + s.w + "%;background:var(--" + s.c + ")",
    })),
    rows: d.rows.map(rowVM),
  })),
});

/** The ledger, in the document's own maturity order. Rendered as-is. */
export const LEDGER: BandVM[] = BANDS.map(bandVM);

/**
 * The layer-sort rules, generated from LAYER_ORDER so the two stay in step.
 * Flexbox keeps document order within an equal `order`, which is exactly the
 * stable-within-a-layer behaviour the source document's sort had.
 */
export const layerOrderCss = (): string =>
  Object.keys(LAYER_ORDER)
    .map((k) => `.mm .by-layer .crow.lr-${k}{order:${LAYER_ORDER[k]}}`)
    .join("\n");

const countRows = (bands: Band[]): number =>
  bands.reduce(
    (n, b) => n + b.domains.reduce((m, d) => m + d.rows.length, 0),
    0,
  );

/**
 * The status key states the document's tally of itself. Count it rather than
 * restating numbers that can drift from the rows.
 */
export const ROW_COUNT = countRows(BANDS);
export const FLAG_COUNT = BANDS.reduce(
  (n, b) =>
    n + b.domains.reduce((m, d) => m + d.rows.filter((r) => r.flag).length, 0),
  0,
);
