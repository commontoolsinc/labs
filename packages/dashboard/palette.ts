// The one place the wall's status colors are chosen, and the one place a shade
// derived from them is worked out. Everything that paints a status in color
// reads from here: the tile, the header dot, the headline, a sparkline's fade,
// a run cell, the drill-down rows, and the favicon. The shape a header dot
// takes is CSS geometry rather than a color, and lives with the rest of the
// tile's CSS in render.ts.
//
// Green sits at teal and amber at orange rather than at a yellow. The two then
// differ along the blue/yellow axis, which red/green color blindness leaves
// working, so good and warn stay apart for a viewer who cannot separate them by
// the red/green axis alone. Color is one of four cues the wall carries: the
// header dot also takes a per-status shape, the tile's wash and border get
// stronger as the status gets more serious, and warn and bad carry a texture.
import type { Status } from "./types.ts";

export const STATUS_COLOR: Record<Status, string> = {
  good: "#2fc79e",
  warn: "#e8913a",
  bad: "#e2504a",
  unknown: "#7c828c",
};

// The headline number, lifted off the status color so it reads as text on the
// dark tile.
export const STATUS_TEXT: Record<Status, string> = {
  good: "#4ed3ae",
  warn: "#f5a34d",
  bad: "#f0726c",
  unknown: "#9aa0ab",
};

// Headline shades for text on a light tile. They retain the status hues while
// carrying enough weight to read against white.
export const LIGHT_STATUS_TEXT: Record<Status, string> = {
  good: "#0f765d",
  warn: "#985000",
  bad: "#a51f45",
  unknown: "#59616e",
};

// How much of its color a tile's background carries, and how much its border
// does. The three rise together with the seriousness of the status, so the
// tiles separate by weight as well as by hue. An unknown tile takes no color
// at all and keeps the neutral border every tile starts from.
export const STATUS_WASH: Record<Status, number> = {
  good: 0.06,
  warn: 0.12,
  bad: 0.15,
  unknown: 0,
};

export const STATUS_EDGE: Record<Status, number> = {
  good: 0.28,
  warn: 0.5,
  bad: 0.58,
  unknown: 0,
};

// The stroke a status texture is drawn in. The line is broad and faint rather
// than fine and dark, which puts enough of it on the tile to be seen at a
// glance without any one line drawing the eye. At this width the zig-zag covers
// a little under half of its tile, and the wave, which runs flatter and so
// leaves more room between its lines, about a third. It is also the bound on
// the stroke: a mitered corner keeps its point inside the pattern tile up to
// this width, and the pattern repeats without a clipped corner.
export const TEXTURE_ALPHA = 0.13;
export const TEXTURE_WIDTH = 8;

// A run that is still going, which is a state rather than a verdict: the same
// blue wherever it appears.
export const RUNNING_COLOR = "#6ea8fe";

// The flat surface a status tints: the tile itself, and the rows of the
// drill-down pages that wear a status the same way.
export const TILE_BASE = "#16181d";
export const LIGHT_TILE_BASE = "#ffffff";

function channels(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex(channels: readonly number[]): string {
  return `#${
    channels.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")
  }`;
}

// How much darker than its tile a sparkline's fade sits.
const FADE_DEPTH = 0.6;

/** The shade a sparkline fades up out of, on a tile of the given status. */
function fadeUnder(status: Status, tileBase: string, depth: number): string {
  const base = channels(tileBase);
  const tint = channels(STATUS_COLOR[status]);
  return hex(
    base.map((b, i) => (b + (tint[i] - b) * STATUS_WASH[status]) * depth),
  );
}

// The left edge of a sparkline's fade gradient, a shade below the tile's own
// background so the line fades up out of it. Worked out from the status color
// and the tile's wash rather than written down beside them, so a change to
// either carries here on its own.
export const SPARK_FADE: Record<Status, string> = {
  good: fadeUnder("good", TILE_BASE, FADE_DEPTH),
  warn: fadeUnder("warn", TILE_BASE, FADE_DEPTH),
  bad: fadeUnder("bad", TILE_BASE, FADE_DEPTH),
  unknown: fadeUnder("unknown", TILE_BASE, FADE_DEPTH),
};

// On a light tile the line can disappear into the tile's own tinted surface.
// The CSS theme chooses between these shades and the dark ones above.
export const LIGHT_SPARK_FADE: Record<Status, string> = {
  good: fadeUnder("good", LIGHT_TILE_BASE, 1),
  warn: fadeUnder("warn", LIGHT_TILE_BASE, 1),
  bad: fadeUnder("bad", LIGHT_TILE_BASE, 1),
  unknown: fadeUnder("unknown", LIGHT_TILE_BASE, 1),
};

export const SPARK_FADE_CSS: Record<Status, string> = {
  good: "var(--spark-fade-good)",
  warn: "var(--spark-fade-warn)",
  bad: "var(--spark-fade-bad)",
  unknown: "var(--spark-fade-unknown)",
};

/** A `#rrggbb` color as a CSS `rgba()` at the given alpha. */
export function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
