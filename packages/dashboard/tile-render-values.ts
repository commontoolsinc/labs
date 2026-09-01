import type { Status } from "./types.ts";
import { CHART_HIGHLIGHT } from "./theme.ts";

// good/warn/bad/unknown -> the dot color class the renderer uses.
export const STATUS_DOT: Record<Status, string> = {
  good: "green",
  warn: "amber",
  bad: "red",
  unknown: "gray",
};

export const escapeHtml = (s: string) =>
  s.replace(
    /[<>&"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!,
  );

// How a sparkline caption spells a day span, consistently across tiles.
export function daysLabel(days: number): string {
  if (days < 1) return "<1 day";
  return `${days} day${days === 1 ? "" : "s"}`;
}

// A time span for sparkline captions: days, then hours, then minutes.
export function humanSpan(ms: number): string {
  if (ms >= 86_400_000) return daysLabel(Math.round(ms / 86_400_000));
  if (ms >= 3_600_000) {
    const hr = Math.round(ms / 3_600_000);
    return `${hr} hour${hr === 1 ? "" : "s"}`;
  }
  return `${Math.max(1, Math.round(ms / 60_000))} min`;
}

export const DURATION_LABEL_HEIGHT = 9;
// All sparkline variants and their duration labels occupy this rendered height.
export const SPARKLINE_HEIGHT = 28;

// The span sits in the bottom-left corner of its positioned chart container.
export function durationTag(ms: number): string {
  return `<span style="position:absolute;left:1px;bottom:0;font-size:${DURATION_LABEL_HEIGHT}px;line-height:1;color:${CHART_HIGHLIGHT};pointer-events:none">${
    escapeHtml(humanSpan(ms))
  }</span>`;
}
