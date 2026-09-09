import type { TileView } from "./types.ts";
import { durationTag, escapeHtml, STATUS_DOT } from "./tile-render-values.ts";

export function renderTile(v: TileView, id?: string, wide = false): string {
  const cls = `tile ${v.status}${v.href ? " link" : ""}${wide ? " wide" : ""}${
    v.alignChartBottom ? " bottom-chart" : ""
  }`;
  const key = id ? ` data-tile-id="${escapeHtml(id)}"` : "";
  const dot = `<span class="dot ${STATUS_DOT[v.status]}"></span>`;
  const hint = v.hint
    ? `<span class="drill" title="${escapeHtml(v.hint)}">${
      escapeHtml(v.hint)
    }</span>`
    : "";
  const header = `<p class="lbl">${dot} ${
    escapeHtml(v.label)
  }<span class="spacer"></span>${v.aside ?? ""}${hint}</p>`;
  const big = v.value !== undefined
    ? `<p class="big ${v.status}"${
      v.valueLabel === undefined ? "" : ` title="${escapeHtml(v.valueLabel)}"`
    }>${v.value}</p>`
    : "";
  const sub = v.sub
    ? `<p class="sub" title="${escapeHtml(v.sub)}">${escapeHtml(v.sub)}</p>`
    : "";
  // A duration labels the chart in `extra`; without chart markup there is no
  // positioned box for the label.
  const body = v.duration && v.extra
    ? `<div class="chart" style="position:relative">${v.extra}${
      durationTag(v.duration)
    }</div>`
    : (v.extra ?? "");
  const inner = `<div class="texture"></div>${header}${big}${sub}${body}`;
  if (!v.href) return `<div class="${cls}"${key}>${inner}</div>`;
  const tgt = /^https?:/.test(v.href) ? ` target="_blank" rel="noopener"` : "";
  return `<a class="${cls}"${key} href="${
    escapeHtml(v.href)
  }"${tgt}>${inner}</a>`;
}
