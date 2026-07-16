// Shared helpers used across tiles and the core.
import type { Status } from "./types.ts";

// Call the GitHub REST API and return parsed JSON. Pass an explicit `token` (e.g.
// a higher-privilege org-billing token); otherwise it reads GH_TOKEN or
// GITHUB_TOKEN from the environment. One of those must be set.
export async function github<T = unknown>(path: string, token?: string): Promise<T> {
  const t = token ?? Deno.env.get("GH_TOKEN") ?? Deno.env.get("GITHUB_TOKEN");
  if (!t) throw new Error(`GitHub API ${path}: set GH_TOKEN or GITHUB_TOKEN`);
  const res = await fetch(`https://api.github.com/${path.replace(/^\//, "")}`, {
    headers: {
      authorization: `Bearer ${t}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${path} failed: HTTP ${res.status}`);
  return await res.json() as T;
}

// Cache an async result for ttlMs; a rejection is not cached (so it retries).
export function memo<T>(ttlMs: number, fn: () => Promise<T>): () => Promise<T> {
  let at = 0;
  let cached: Promise<T> | null = null;
  return () => {
    if (!cached || Date.now() - at > ttlMs) {
      at = Date.now();
      cached = fn().catch((e) => {
        cached = null;
        throw e;
      });
    }
    return cached;
  };
}

// good/warn/bad/unknown -> the dot color class the renderer uses.
export const STATUS_DOT: Record<Status, string> = { good: "green", warn: "amber", bad: "red", unknown: "grey" };

export const escapeHtml = (s: string) =>
  s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));

export const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// Per-status left edge for a sparkline's fade gradient — a shade just below the
// tile's own (status-tinted) background, so the line fades up out of the tile.
export const SPARK_FADE: Record<Status, string> = {
  good: "#0e1915",
  warn: "#1a1713",
  bad: "#1e1113",
  unknown: "#121317",
};

// How a sparkline caption spells a day span, consistently across tiles:
// "5 days", "1 day", "<1 day".
export function daysLabel(days: number): string {
  if (days < 1) return "<1 day";
  return `${days} day${days === 1 ? "" : "s"}`;
}

// A time span for sparkline captions: "5 days" (>= 1 day, via daysLabel), else a
// finer "8 hours", else "30 min".
export function humanSpan(ms: number): string {
  if (ms >= 86_400_000) return daysLabel(Math.round(ms / 86_400_000));
  if (ms >= 3_600_000) {
    const hr = Math.round(ms / 3_600_000);
    return `${hr} hour${hr === 1 ? "" : "s"}`;
  }
  return `${Math.max(1, Math.round(ms / 60_000))} min`;
}

export function humanDur(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function clampInt(v: string | null, def: number, lo: number, hi: number): number {
  if (v === null || v.trim() === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

// Turn a raw collector error into a short, calm tile message. The full error is
// still logged; the wall shows a human phrase, not a stack trace or API path.
export function friendlyError(msg: string): string {
  const m = msg.toLowerCase();
  if (/connect|sending request|network|dns|refused|unreachable|timed ?out|timeout|econn/.test(m)) {
    return "source unreachable";
  }
  if (/rate.?limit|\b429\b/.test(m)) return "rate-limited";
  if (/\b404\b|not found/.test(m)) return "not found";
  if (/\b401\b|\b403\b|unauthor|forbidden|bad credentials/.test(m)) return "auth failed";
  if (/gh_token|github_token/.test(m)) return "set GH_TOKEN";
  return "temporarily unavailable";
}

// Spend against a budget, matching the cloud-spend thresholds: at or under budget
// is good, up to 25% over is a warning, beyond that is bad. An unset or invalid
// budget (NaN) never alarms.
export function budgetStatus(cost: number, budget: number): Status {
  if (!Number.isFinite(budget)) return "good";
  return cost <= budget ? "good" : cost <= budget * 1.25 ? "warn" : "bad";
}

// Parse an optional numeric budget/quota from an env string; blank or unset -> NaN.
export function readBudget(raw: string | undefined): number {
  return raw !== undefined && raw.trim() !== "" ? Number(raw) : NaN;
}

// A completed run's dot color: only genuine failures are red.
export function concDot(conclusion: string | null, attempt: number): string {
  if (conclusion === "success") return attempt > 1 ? "grey" : "green";
  if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "startup_failure") return "red";
  return "grey";
}

// A trend line from a numeric series (oldest -> newest). With `highlight`, the
// trailing `count` points are overdrawn in a second color (e.g. to pick out the
// most recent runs against a longer trend). The vertical scale is normalized to
// those recent points' range plus 25% headroom, so older outliers clip off the
// edges instead of flattening the recent detail into a useless line. `caption`
// adds tiny text in the bottom-left corner, in the highlight color, (e.g. the
// span the line covers). `fadeFrom` makes the base line a horizontal gradient
// from that color on the far left up to `color` by the tile's midpoint. `xs`
// gives each point's horizontal position as a fraction 0..1 of the width (for
// placing several sparklines on one shared axis — e.g. a real time axis); a
// series that doesn't reach the ends occupies only part of the width. Without it,
// points are spaced evenly.
export function sparkline(
  vals: number[],
  color: string,
  highlight?: { count: number; color: string },
  caption?: string,
  fadeFrom?: string,
  xs?: number[],
): string {
  if (vals.length < 2) return "";
  const w = 220, h = 26;
  const recent = highlight ? vals.slice(-highlight.count) : vals;
  const lo = Math.min(...recent), hi = Math.max(...recent);
  const pad = (hi - lo) * 0.125 || 0.5; // 12.5% each side ≈ +25% range; a floor for a flat series
  const min = lo - pad, rng = (hi + pad) - min;
  // Place each point at its `xs` fraction of the width (shared axis), else evenly.
  const xAt = (i: number) => (xs ? xs[i] : i / (vals.length - 1)) * w;
  const pts = vals.map((v, i) =>
    `${xAt(i).toFixed(1)},${(h - 3 - ((v - min) / rng) * (h - 6)).toFixed(1)}`
  );
  // The base line fades from `fadeFrom` on the far left to `color`, then holds
  // `color` (SVG extends the last stop). objectBoundingBox units keep the
  // transition placed regardless of the preserveAspectRatio stretch.
  let defs = "", baseStroke = color;
  if (fadeFrom) {
    // Reach `color` by the tile's midpoint — or sooner, if the highlight starts
    // before halfway (so the base is fully `color` before the handoff).
    const edge = highlight
      ? Math.max(0, Math.min(1, (vals.length - highlight.count) / (vals.length - 1)))
      : 1;
    const tf = Math.min(0.5, edge);
    if (tf > 0) {
      const id = `spk-${fadeFrom.replace(/[^0-9a-fA-F]/g, "")}-${color.replace(/[^0-9a-fA-F]/g, "")}-${Math.round(tf * 100)}`;
      defs = `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">` +
        `<stop offset="0" stop-color="${fadeFrom}"/><stop offset="${tf.toFixed(3)}" stop-color="${color}"/>` +
        `</linearGradient></defs>`;
      baseStroke = `url(#${id})`;
    }
  }
  const lines = [`<polyline points="${pts.join(" ")}" fill="none" stroke="${baseStroke}" stroke-width="2"/>`];
  if (highlight && highlight.count >= 2) {
    const tail = pts.slice(Math.max(0, vals.length - highlight.count));
    lines.push(`<polyline points="${tail.join(" ")}" fill="none" stroke="${highlight.color}" stroke-width="2"/>`);
  }
  const svg = (style: string) =>
    `<svg viewBox="0 0 ${w} ${h}" width="100%" height="24" preserveAspectRatio="none" style="${style}">${defs}${lines.join("")}</svg>`;
  if (!caption) return svg("margin-top:9px");
  // The caption is HTML, not SVG text, so preserveAspectRatio="none" can't
  // stretch it; it sits over the bottom-left of the line in the highlight color.
  // Highlighted lines caption in the highlight colour; otherwise the standard
  // muted-bright caption grey shared by the tiles, bottom-left of the line.
  const capColor = highlight?.color ?? "#c7ccd4";
  return `<div style="position:relative;margin-top:9px">${svg("display:block")}` +
    `<span style="position:absolute;left:1px;bottom:0;font-size:9px;line-height:1;color:${capColor};pointer-events:none">${escapeHtml(caption)}</span></div>`;
}

// Overlaid trend lines (each oldest -> newest) sharing one vertical scale, each
// in its own color. With a per-series `label`, that series' value is placed in a
// right-hand gutter at the line's end height, in the line color. With
// `opts.fadeFrom`, each line fades from that color on the far left up to its own
// color by the midpoint (like the ci-duration sparkline). `opts.caption` adds
// tiny text in the bottom-left corner. All overlays are HTML/gradient, so the
// preserveAspectRatio="none" stretch can't distort them. Returns "" until there
// are at least two points to plot.
export function multiSparkline(
  series: { vals: number[]; color: string; label?: string }[],
  opts: { fadeFrom?: string; caption?: string } = {},
): string {
  const all = series.flatMap((s) => s.vals);
  const points = Math.max(0, ...series.map((s) => s.vals.length));
  if (points < 2 || all.length === 0) return "";
  const w = 220, h = 34, min = Math.min(...all), max = Math.max(...all), rng = (max - min) || 1;
  const yv = (v: number) => h - 3 - ((v - min) / rng) * (h - 6);

  // Each line can fade from `fadeFrom` on the left to its own color by the
  // midpoint. userSpaceOnUse keeps the transition at the same screen x for every
  // line and avoids the zero-bbox quirk when a line is flat.
  const defs: string[] = [];
  const strokeFor = (color: string): string => {
    if (!opts.fadeFrom) return color;
    const id = `mspk-${opts.fadeFrom.replace(/[^0-9a-fA-F]/g, "")}-${color.replace(/[^0-9a-fA-F]/g, "")}`;
    if (!defs.some((d) => d.includes(`"${id}"`))) {
      defs.push(
        `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${w}" y2="0">` +
          `<stop offset="0" stop-color="${opts.fadeFrom}"/><stop offset="0.5" stop-color="${color}"/>` +
          `</linearGradient>`,
      );
    }
    return `url(#${id})`;
  };
  const lines = series.map((s) =>
    s.vals.length < 2 ? "" : `<polyline points="${
      s.vals.map((v, i) => `${(i / (s.vals.length - 1) * w).toFixed(1)},${yv(v).toFixed(1)}`).join(" ")
    }" fill="none" stroke="${strokeFor(s.color)}" stroke-width="2"/>`
  ).join("");
  const defsBlock = defs.length ? `<defs>${defs.join("")}</defs>` : "";

  const labeled = series.filter((s) => s.label !== undefined && s.vals.length >= 2);
  if (labeled.length === 0 && !opts.caption) {
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="32" preserveAspectRatio="none" style="margin-top:9px">${defsBlock}${lines}</svg>`;
  }
  const RH = 32; // rendered svg height, px
  const tags = labeled.map((s) => {
    const py = Math.max(6, Math.min(26, (yv(s.vals[s.vals.length - 1]) / h) * RH));
    return `<span style="position:absolute;right:0;top:${py.toFixed(1)}px;transform:translateY(-50%);font-size:11px;line-height:1;color:${s.color};font-variant-numeric:tabular-nums;pointer-events:none">${escapeHtml(s.label!)}</span>`;
  }).join("");
  const caption = opts.caption
    // Same muted-bright as the ci-duration sparkline's span caption.
    ? `<span style="position:absolute;left:1px;bottom:0;font-size:9px;line-height:1;color:#c7ccd4;pointer-events:none">${escapeHtml(opts.caption)}</span>`
    : "";
  const svgWidth = labeled.length ? "calc(100% - 24px)" : "100%";
  const svg = `<svg viewBox="0 0 ${w} ${h}" width="${svgWidth}" height="${RH}" preserveAspectRatio="none" style="display:block">${defsBlock}${lines}</svg>`;
  return `<div style="position:relative;margin-top:9px;height:${RH}px">${svg}${tags}${caption}</div>`;
}

// Evenly thin an array to at most `max` items, keeping the first and last.
export function thin<T>(arr: T[], max: number): T[] {
  if (max < 2 || arr.length <= max) return arr;
  const out: T[] = [];
  const step = (arr.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

// A grid of small pass/fail cells (one per run, oldest first) laid out in `cols`
// fixed columns; each cell links to that run's CI results. The caller sizes the
// cells to a whole number of rows, so the grid is always complete (no half-empty
// final row). Cells shrink to fit width.
export function strip(cells: { outcome: string; href: string }[], cols: number): string {
  if (!cells.length) return "";
  const col = (d: string) => d === "green" ? "#43c574" : d === "red" ? "#e2504a" : "#7c828c";
  const html = cells.map((c) =>
    `<a class="cell" href="${escapeHtml(c.href)}" target="_blank" rel="noopener" style="background:${col(c.outcome)}"></a>`
  ).join("");
  return `<div class="cells" style="grid-template-columns:repeat(${cols},1fr)">${html}</div>`;
}

// The PR that landed a commit: squash titles end "(#123)", merge commits start
// "Merge pull request #123". Parses the full message first line; falls back to
// the commit page so a mid-message "#456" never mislinks.
export function landingHref(message: string, sha: string, repo: string): string {
  const first = message.split("\n", 1)[0];
  const pr = first.match(/\(#(\d+)\)\s*$/)?.[1] ?? first.match(/^Merge pull request #(\d+)/)?.[1];
  return pr ? `https://github.com/${repo}/pull/${pr}` : `https://github.com/${repo}/commit/${sha}`;
}
