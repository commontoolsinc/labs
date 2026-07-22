// Shared helpers used across tiles and the core.
import type { Status } from "./types.ts";
import { PROD_SERVICE } from "./config.ts";
import {
  type GitHubPrimaryRateLimit,
  performanceGitHubRateLimit,
} from "./github-rate-limit.ts";

// The service.name to scope a SigNoz query to. The name lands inside a query
// expression, so anything outside the shape a service name has falls back to the
// configured default rather than being interpolated.
export const serviceName = (env: (k: string) => string | undefined): string => {
  const s = env("PROD_SERVICE");
  return s && /^[A-Za-z0-9._-]+$/.test(s) ? s : PROD_SERVICE;
};

// Call the GitHub REST API and return parsed JSON. Pass an explicit `token` (e.g.
// a higher-privilege org-billing token); otherwise it reads GH_TOKEN or
// GITHUB_TOKEN from the environment. One of those must be set.
function githubToken(path: string, token?: string): string {
  const t = token ?? Deno.env.get("GH_TOKEN") ?? Deno.env.get("GITHUB_TOKEN");
  if (!t) throw new Error(`GitHub API ${path}: set GH_TOKEN or GITHUB_TOKEN`);
  return t;
}

function githubRequest(path: string, token: string, withTimeout: boolean): Promise<Response> {
  const init: RequestInit = {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  };
  if (withTimeout) init.signal = AbortSignal.timeout(15_000);
  return fetch(
    `https://api.github.com/${path.replace(/^\//, "")}`,
    init,
  );
}

async function githubPrimaryRateLimit(
  token: string,
): Promise<GitHubPrimaryRateLimit> {
  const response = await githubRequest("rate_limit", token, false);
  if (!response.ok) {
    throw new Error(`GitHub API rate_limit failed: HTTP ${response.status}`);
  }
  const value = await response.json() as {
    resources?: { core?: GitHubPrimaryRateLimit };
  };
  if (!value.resources?.core) {
    throw new Error("GitHub API rate_limit did not report the core budget");
  }
  return value.resources.core;
}

async function githubResponse(
  path: string,
  token: string,
  performance: boolean,
  withTimeout: boolean,
): Promise<Response> {
  const reservation = performance
    ? await performanceGitHubRateLimit.reserve(
      token,
      () => githubPrimaryRateLimit(token),
    )
    : null;
  let response: Response | undefined;
  try {
    response = await githubRequest(path, token, withTimeout);
    return response;
  } finally {
    if (reservation) await reservation.complete(response);
  }
}

async function githubJson<T>(
  path: string,
  token: string,
  performance: boolean,
): Promise<T> {
  const res = await githubResponse(path, token, performance, true);
  if (!res.ok) {
    let rateLimited = false;
    if (res.status === 403) {
      const message = await res.text();
      rateLimited = res.headers.get("x-ratelimit-remaining") === "0" ||
        res.headers.has("retry-after") || /rate.?limit/i.test(message);
    }
    const detail = rateLimited ? " (rate-limited)" : "";
    throw new Error(
      `GitHub API ${path} failed: HTTP ${res.status}${detail}`,
    );
  }
  return await res.json() as T;
}

export async function github<T = unknown>(
  path: string,
  token?: string,
): Promise<T> {
  const t = githubToken(path, token);
  return await githubJson<T>(path, t, false);
}

export async function githubDownload(
  path: string,
  token?: string,
): Promise<Response> {
  const t = githubToken(path, token);
  return await githubResponse(path, t, false, false);
}

export async function performanceGithub<T = unknown>(
  path: string,
  token?: string,
): Promise<T> {
  const t = githubToken(path, token);
  return await githubJson<T>(path, t, true);
}

export async function performanceGithubDownload(
  path: string,
  token?: string,
): Promise<Response> {
  const t = githubToken(path, token);
  return await githubResponse(path, t, true, false);
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
  if (/rate.?limit|\b429\b/.test(m)) return "rate limit hit";
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

// A USD amount as a short string: whole dollars, or cents when it is under a
// dollar (so 0.45 -> "45¢"), and "$0" when it rounds away entirely.
export function usd(n: number): string {
  const cents = Math.round(n * 100);
  if (cents === 0) return "$0";
  if (Math.abs(cents) < 100) return `${cents}¢`;
  return `$${Math.round(n)}`;
}

// A completed run's dot color: only genuine failures are red.
export function concDot(conclusion: string | null, attempt: number): string {
  if (conclusion === "success") return attempt > 1 ? "grey" : "green";
  if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "startup_failure") return "red";
  return "grey";
}

// A lighter tint of a "#rrggbb" color, blended toward white. Sparklines mark the
// slice feeding the headline by redrawing it in a lighter version of the line's
// own color, so a multi-color chart can highlight without losing which line is
// which. Anything that is not a hex color is returned unchanged.
export function lighten(hex: string, amount = 0.6): string {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1], 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const [r, g, b] = [mix((n >> 16) & 255), mix((n >> 8) & 255), mix(n & 255)];
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

// The span the line covers, formatted with humanSpan for the bottom-left corner
// of a chart, absolutely positioned. The renderer draws it for a tile's `duration`
// slot; standalone chart pages (the bench drill-down) reuse it directly. Its
// container must be position:relative.
export function durationTag(ms: number): string {
  return `<span style="position:absolute;left:1px;bottom:0;font-size:9px;line-height:1;color:#c7ccd4;pointer-events:none">${escapeHtml(humanSpan(ms))}</span>`;
}

// A trend line from a numeric series (oldest -> newest). With `highlight`, the
// trailing `count` points are overdrawn in a second color (e.g. to pick out the
// most recent runs against a longer trend). The vertical scale is normalized to
// those recent points' range plus 25% headroom, so older outliers clip off the
// edges instead of flattening the recent detail into a useless line. `fadeFrom`
// makes the base line a horizontal gradient from that color on the far left up to
// `color` by the tile's midpoint. `xs` gives each point's horizontal position as a
// fraction 0..1 of the width (for placing several sparklines on one shared axis —
// e.g. a real time axis); a series that doesn't reach the ends occupies only part
// of the width. Without it, points are spaced evenly. The line has no label of its
// own — a tile's `duration` slot draws the span in the corner.
export function sparkline(
  vals: number[],
  color: string,
  highlight?: { count: number; color: string; scaleAll?: boolean },
  fadeFrom?: string,
  xs?: number[],
): string {
  if (vals.length < 2) return "";
  const w = 220, h = 26;
  // Scale to the highlighted tail (recent) by default; scaleAll keeps the full
  // series in view while still brightening the tail (for series whose recent
  // window can sit far from the historical range, e.g. a near-zero error rate).
  const recent = highlight && !highlight.scaleAll ? vals.slice(-highlight.count) : vals;
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
  // A tail covering the whole series marks nothing off, and would repaint the
  // line in the highlight color, so the base is left to stand on its own.
  if (highlight && highlight.count >= 2 && highlight.count < vals.length) {
    const tail = pts.slice(vals.length - highlight.count);
    lines.push(`<polyline points="${tail.join(" ")}" fill="none" stroke="${highlight.color}" stroke-width="2"/>`);
  }
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="24" preserveAspectRatio="none" style="margin-top:9px">${defs}${lines.join("")}</svg>`;
}

// Overlaid trend lines (each oldest -> newest) sharing one vertical scale, each
// in its own color. With a per-series `label`, that series' value is placed in a
// right-hand gutter at the line's end height, in the line color. With
// `opts.fadeFrom`, each line fades from that color on the far left up to its own
// color, reaching full color by the midpoint (or by the start of the highlight,
// if that comes sooner) — like the ci-duration sparkline. `opts.highlight`
// redraws the trailing `count` points of every line in a lighter tint of that
// line's own color, picking out the slice that feeds the headline while keeping
// each line identifiable. All overlays are HTML/gradient, so the
// preserveAspectRatio="none" stretch can't distort them. Returns "" until there
// are at least two points to plot. The span it covers is drawn separately by a
// tile's `duration` slot.
export function multiSparkline(
  series: { vals: number[]; color: string; label?: string }[],
  opts: { fadeFrom?: string; highlight?: { count: number } } = {},
): string {
  const all = series.flatMap((s) => s.vals);
  const points = Math.max(0, ...series.map((s) => s.vals.length));
  if (points < 2 || all.length === 0) return "";
  const w = 220, h = 34, min = Math.min(...all), max = Math.max(...all), rng = (max - min) || 1;
  const yv = (v: number) => h - 3 - ((v - min) / rng) * (h - 6);

  // Each line fades from `fadeFrom` on the left up to its own color, reaching full
  // color at the handoff `tf`: the midpoint, or the start of the highlight when
  // that comes sooner (so the base is solid before the handoff). userSpaceOnUse
  // keeps the transition at the same screen x for every line and avoids the
  // zero-bbox quirk when a line is flat.
  const edge = opts.highlight && points > 1
    ? Math.max(0, Math.min(1, (points - opts.highlight.count) / (points - 1)))
    : 1;
  const tf = Math.min(0.5, edge);
  const off = String(+tf.toFixed(3));
  const defs: string[] = [];
  const strokeFor = (color: string): string => {
    if (!opts.fadeFrom) return color;
    const id = `mspk-${opts.fadeFrom.replace(/[^0-9a-fA-F]/g, "")}-${color.replace(/[^0-9a-fA-F]/g, "")}-${Math.round(tf * 100)}`;
    if (!defs.some((d) => d.includes(`"${id}"`))) {
      defs.push(
        `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${w}" y2="0">` +
          `<stop offset="0" stop-color="${opts.fadeFrom}"/><stop offset="${off}" stop-color="${color}"/>` +
          `</linearGradient>`,
      );
    }
    return `url(#${id})`;
  };
  const hl = opts.highlight;
  const poly = (pts: string[], stroke: string) => `<polyline points="${pts.join(" ")}" fill="none" stroke="${stroke}" stroke-width="2"/>`;
  const drawn = series.filter((s) => s.vals.length >= 2).map((s) => ({
    s,
    pts: s.vals.map((v, i) => `${(i / (s.vals.length - 1) * w).toFixed(1)},${yv(v).toFixed(1)}`),
  }));
  // Every base first, then every tint, so a line drawn later cannot paint over an
  // earlier line's tint where the two cross inside the highlighted slice.
  const bases = drawn.map(({ s, pts }) => poly(pts, strokeFor(s.color))).join("");
  // The trailing slice, redrawn in a lighter tint of each line's own color. A
  // slice covering the whole line marks nothing off, so it is left alone.
  const tints = drawn.map(({ s, pts }) => {
    const n = hl ? Math.min(hl.count, pts.length) : 0;
    return n >= 2 && n < pts.length ? poly(pts.slice(pts.length - n), lighten(s.color)) : "";
  }).join("");
  const lines = bases + tints;
  const defsBlock = defs.length ? `<defs>${defs.join("")}</defs>` : "";

  const labeled = series.filter((s) => s.label !== undefined && s.vals.length >= 2);
  if (labeled.length === 0) {
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="32" preserveAspectRatio="none" style="margin-top:9px">${defsBlock}${lines}</svg>`;
  }
  const RH = 32; // rendered svg height, px
  // Each label sits at its line's end height; when a chart is drawn its value
  // appears only here, so spread any labels that would overlap into one unreadable
  // stack — sort by height and push each down to at least MIN_GAP below the last.
  const MIN_GAP = 12;
  const placed = labeled
    .map((s) => ({ s, py: Math.max(6, Math.min(26, (yv(s.vals[s.vals.length - 1]) / h) * RH)) }))
    .sort((a, b) => a.py - b.py);
  for (let i = 1; i < placed.length; i++) {
    if (placed[i].py - placed[i - 1].py < MIN_GAP) placed[i].py = placed[i - 1].py + MIN_GAP;
  }
  const overflow = placed.length ? placed[placed.length - 1].py - 26 : 0;
  if (overflow > 0) for (const p of placed) p.py -= overflow;
  const tags = placed.map(({ s, py }) =>
    `<span style="position:absolute;right:0;top:${py.toFixed(1)}px;transform:translateY(-50%);font-size:11px;line-height:1;color:${s.color};font-variant-numeric:tabular-nums;pointer-events:none">${escapeHtml(s.label!)}</span>`
  ).join("");
  const svgWidth = labeled.length ? "calc(100% - 24px)" : "100%";
  const svg = `<svg viewBox="0 0 ${w} ${h}" width="${svgWidth}" height="${RH}" preserveAspectRatio="none" style="display:block">${defsBlock}${lines}</svg>`;
  return `<div style="position:relative;margin-top:9px;height:${RH}px">${svg}${tags}</div>`;
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
