// Uniform rendering: every tile becomes the same markup from its TileView, and
// the shell wraps the grid + wide tiles in the dark page with the SSE client.
import type { Status, TileView } from "./types.ts";
import { durationTag, escapeHtml, STATUS_DOT } from "./lib.ts";
import {
  rgba,
  RUNNING_COLOR,
  STATUS_COLOR,
  STATUS_EDGE,
  STATUS_TEXT,
  STATUS_WASH,
  TEXTURE_ALPHA,
  TEXTURE_WIDTH,
  TILE_BASE,
} from "./palette.ts";
import { faviconHref, faviconLink, type FaviconStatus } from "./favicon.ts";
import { paintStatusFavicon } from "./favicon-client.ts";
import { liveUpdateStream } from "./stream-client.ts";

const FAVICON_PNG_HREFS = JSON.stringify({
  good: faviconHref("good"),
  warn: faviconHref("warn"),
  bad: faviconHref("bad"),
  "bad-crying": faviconHref("bad-crying"),
});
const PAINT_STATUS_FAVICON = paintStatusFavicon.toString();
const LIVE_UPDATE_STREAM = liveUpdateStream.toString();

// How long past the refresh interval the freshness indicator stays orange before
// it turns red. The page treats the same span of silence from the server as a
// stream that has stopped delivering, and reconnects.
const STALE_GRACE_MS = 10_000;

export const FAVICON_CRY_AFTER_MS = 60 * 60 * 1000;

// A texture tile is this tall, and one line's worth of it repeats down the
// layer at that spacing. The width is the pattern's own period, so the tile
// holds a whole number of them and repeats across without a seam.
const TEXTURE_HEIGHT = 24;

/**
 * A tiling background of one stroked path, for the texture that sits behind a
 * tile's flat colour wash. Returns the whole background declaration, because
 * the size the tile repeats at is part of the pattern rather than a separate
 * choice. The path is drawn in a `period` by `TEXTURE_HEIGHT` space, and its
 * corners come to a point.
 *
 * A path has to begin and end on the left and right edges of that space,
 * heading the same way at both, so the two ends butt together where the
 * pattern repeats. The round cap is what makes that joint clean: it fills the
 * stroke out to the edge, and the part that reaches past is clipped away.
 */
function strokeTexture(path: string, stroke: string, period: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${period}" height="${TEXTURE_HEIGHT}" ` +
    `viewBox="0 0 ${period} ${TEXTURE_HEIGHT}">` +
    `<path d="${path}" fill="none" stroke="${stroke}" ` +
    `stroke-width="${TEXTURE_WIDTH}" stroke-linecap="round"/></svg>`;
  return `background-image:url("data:image/svg+xml,${
    encodeURIComponent(svg)
  }");background-size:${period}px ${TEXTURE_HEIGHT}px`;
}

// The wave rises and falls once across its period, which is long enough for a
// stroke this wide to follow without a crest reaching the trough below it. It
// starts and ends halfway up a rise, which is where the pattern repeats.
const WAVE_PERIOD = 60;
const WAVE_TEXTURE = strokeTexture(
  `M0 12q${WAVE_PERIOD / 4} -8 ${WAVE_PERIOD / 2} 0t${WAVE_PERIOD / 2} 0`,
  rgba(STATUS_COLOR.warn, TEXTURE_ALPHA),
  WAVE_PERIOD,
);
// Two turns of the zig-zag, which puts its period at half the tile. It starts
// and ends halfway along a run rather than on a corner, which keeps every
// corner inside a tile, where the join between its two runs draws the point.
const ZIGZAG_TEXTURE = strokeTexture(
  "M0 12l6-6 12 12 12-12 12 12 6-6",
  rgba(STATUS_COLOR.bad, TEXTURE_ALPHA),
  48,
);
// Two copies of the same dot grid make a triangular lattice, where each dot has
// six neighbours at one distance rather than a square lattice's four near ones
// and four far ones. The copies are one dot spacing apart across, one spacing
// times the square root of three apart down, and the second copy is shifted by
// half of each. That puts its dots above the midpoint of the gap between two
// dots of the first copy, one spacing away from both, and the same distance
// again from the two below.
const DOT_SPACING_PX = 16;
const DOT_ROW_PX = DOT_SPACING_PX * Math.sqrt(3);
const DOT_STIPPLE = `radial-gradient(${
  rgba(STATUS_COLOR.unknown, 0.15)
} 1px,transparent 1px)`;
const DOT_TEXTURE = [
  `background-image:${DOT_STIPPLE},${DOT_STIPPLE};`,
  `background-position:0 0,${DOT_SPACING_PX / 2}px ${
    (DOT_ROW_PX / 2).toFixed(2)
  }px;`,
  `background-size:${DOT_SPACING_PX}px ${DOT_ROW_PX.toFixed(2)}px`,
].join("");

// The tallest a tile is taken to be against its own width. The grid gives a
// tile at least 220 pixels across and lets its height follow its content, and
// the tightest the two come is a little under square, on the narrowest layout
// the grid produces. The margin above that carries a label or a sub line that
// wraps onto another line or two.
const MAX_TILE_ASPECT = 1.5;

// The side of the square texture layer, as a percentage of the tile's width.
// Turning the layer sweeps its corners inward, so half its side has to reach
// the tile's corner from the tile's centre — the tile's half-diagonal — at
// whatever angle the texture is turned to.
const TEXTURE_LAYER_PCT = Math.ceil(Math.hypot(1, MAX_TILE_ASPECT) * 100);

const STATUSES: readonly Status[] = ["good", "warn", "bad", "unknown"];

// A tile's own color: the wash behind it and the border around it, both
// stronger the more serious the status is. An unknown tile takes neither and
// keeps the neutral border below.
const TILE_RULES = STATUSES.filter((s) => s !== "unknown").map((s) =>
  `  .tile.${s},.tile.wide.${s}{border-color:${
    rgba(STATUS_COLOR[s], STATUS_EDGE[s])
  };background:${rgba(STATUS_COLOR[s], STATUS_WASH[s])}}`
).join("\n");

const BIG_RULES = STATUSES.map((s) => `.big.${s}{color:${STATUS_TEXT[s]}}`)
  .join("");

// The header dot's shape, which says the same thing its color does without
// using color: a circle when all is well, a triangle to warn, a diamond when
// something needs a person, and a hollow ring when the tile cannot tell. The
// diamond is drawn a pixel over each edge so it carries the weight the circle
// does at the same nominal size.
const DOT_SHAPE: Record<Status, string> = {
  good: "border-radius:50%",
  warn: "clip-path:polygon(50% 0,100% 100%,0 100%)",
  bad: "inset:-1px;clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%)",
  unknown: "border-radius:50%",
};

const DOT_RULES = STATUSES.map((s) =>
  `.dot.${STATUS_DOT[s]}::before{${DOT_SHAPE[s]};${
    s === "unknown"
      ? `border:2px solid ${STATUS_COLOR[s]}`
      : `background:${STATUS_COLOR[s]}`
  }}`
).join("") +
  `.dot.run::before{border-radius:50%;background:${RUNNING_COLOR}}`;

type ViewerTimeElement = Pick<HTMLTimeElement, "dateTime" | "textContent">;

/** Replace marked absolute timestamps with the viewer's local wall-clock time. */
export function formatViewerTimes(
  times: Iterable<ViewerTimeElement> = document.querySelectorAll<
    HTMLTimeElement
  >(
    "time[data-viewer-time][datetime]",
  ),
  formatter: { format(value: number): string } = new Intl.DateTimeFormat(
    undefined,
    {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    },
  ),
): void {
  for (const time of times) {
    const at = Date.parse(time.dateTime);
    if (Number.isFinite(at)) time.textContent = formatter.format(at);
  }
}

export function renderTile(v: TileView, id?: string, wide = false): string {
  const cls = `tile ${v.status}${v.href ? " link" : ""}${wide ? " wide" : ""}`;
  const key = id ? ` data-tile-id="${escapeHtml(id)}"` : "";
  const dot = `<span class="dot ${STATUS_DOT[v.status]}"></span>`;
  const hint = v.hint ? `<span class="drill">${escapeHtml(v.hint)}</span>` : "";
  const header = `<p class="lbl">${dot} ${
    escapeHtml(v.label)
  }<span class="spacer"></span>${v.aside ?? ""}${hint}</p>`;
  const big = v.value !== undefined
    ? `<p class="big ${v.status}">${v.value}</p>`
    : "";
  const sub = v.sub ? `<p class="sub">${escapeHtml(v.sub)}</p>` : "";
  // The chart plus its duration label (bottom-left corner, auto-formatted). The
  // relative wrapper positions the duration; a tile with no duration renders extra
  // unwrapped, unchanged. The label describes the chart's span, so it needs a chart
  // to sit in: drawn without one, the wrapper has no height and the label lands on
  // top of the sub line. A tile whose series is too short to plot still reports a
  // span, so this is reachable.
  const body = v.duration && v.extra
    ? `<div style="position:relative">${v.extra}${
      durationTag(v.duration)
    }</div>`
    : (v.extra ?? "");
  // The status texture is painted by this empty layer rather than by the tile,
  // because the texture is turned on an angle and drawn past every edge, while
  // the fade that thins it towards the bottom is measured against the tile.
  // Those are two frames of reference, so they need two boxes.
  const inner = `<div class="texture"></div>${header}${big}${sub}${body}`;
  if (!v.href) return `<div class="${cls}"${key}>${inner}</div>`;
  const tgt = /^https?:/.test(v.href) ? ` target="_blank" rel="noopener"` : "";
  return `<a class="${cls}"${key} href="${
    escapeHtml(v.href)
  }"${tgt}>${inner}</a>`;
}

function renderShell(
  gridHtml: string,
  wideHtml: string,
  ago: number,
  refreshMs: number,
  shellVersion: string,
  status: FaviconStatus,
  serverRedSince: number | null = null,
  serverRedAgeMs: number | null = null,
): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fabric wall — LIVE</title>
${faviconLink(status)}
<style>
  body{margin:0;background:#0d0e11;color:#e7e9ee;font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:18px 20px 26px;max-width:1100px;margin:0 auto}
  .top{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
  .brand b{font-size:16px;font-weight:600}.brand span{font-size:12px;color:#6f757f;margin-left:8px}
  .badge{font-size:11px;color:${STATUS_TEXT.good};border:1px solid ${
    rgba(STATUS_COLOR.good, 0.4)
  };border-radius:6px;padding:2px 8px;margin-left:8px}
  .live{font-size:12px;color:#9aa0ab}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-bottom:12px}
  .tile{background:${TILE_BASE};border:1px solid #23262d;border-radius:12px;padding:14px 16px;position:relative;isolation:isolate;overflow:hidden}
  .tile.wide{margin-bottom:12px}
${TILE_RULES}
  .tile.unknown,.tile.wide.unknown{border-color:#2f333c}
  /* Each status carries a texture as well as a colour, so the wall reads at a
     glance and without relying on colour alone: dots for gray, waves for
     amber, zig-zags for red. The waves run across the zig-zags, a quarter turn
     from the angle the others take. The texture layer covers the tile and sits
     above the colour wash and below the content. It carries the fade: whole
     for the top seventh of the tile, thinning from there, and gone seven
     tenths of the way down. Inside it the texture is turned on an angle, on a
     square layer centred on the tile and measured from the tile's width.
     Turning a box sweeps its corners inward, so the layer only still covers
     the tile if half its side reaches the tile's corner from the centre. That
     distance is the tile's half-diagonal, which ${TEXTURE_LAYER_PCT}% of the
     width clears for a tile up to ${MAX_TILE_ASPECT} times as tall as it is
     wide. The fade is measured against the tile and the texture is drawn in
     the turned frame, which is why they are two boxes rather than one. */
  .texture{position:absolute;inset:0;z-index:-1;overflow:hidden;mask-image:linear-gradient(to bottom,#000 15%,transparent 70%)}
  .texture::before{content:"";position:absolute;top:50%;left:50%;width:${TEXTURE_LAYER_PCT}%;aspect-ratio:1;transform:translate(-50%,-50%) rotate(var(--turn,30deg))}
  .tile.unknown .texture::before{${DOT_TEXTURE}}
  .tile.warn .texture::before{${WAVE_TEXTURE};--turn:120deg}
  .tile.bad .texture::before{${ZIGZAG_TEXTURE}}
  .lbl{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#a5adb9;margin:0 0 7px;display:flex;align-items:center;gap:7px}
  .lbl .spacer{flex:1}
  .drill{font-size:10px;color:#9ba3b0;letter-spacing:0;text-transform:none}
  .hmtd{font-size:11px;color:#9aa0ab;letter-spacing:0;text-transform:none;font-variant-numeric:tabular-nums;margin-right:8px}
  /* Fixed line-height so the headline's line box is the same height regardless of
     which font the glyph comes from: the ▲/▼ trend arrows fall back to a taller
     symbol font, and under line-height:normal that stretched the tile. */
  .big{font-size:30px;font-weight:600;margin:0;line-height:1.2}
  ${BIG_RULES}
  .sub{font-size:13px;color:#9aa0ab;margin:5px 0 0}
  .running{display:inline-flex;align-items:center;gap:5px;font-size:10px;color:#9ba3b0;letter-spacing:.02em;text-transform:none;margin-top:10px}
  /* In the header the badge is a facet of a single line, not a block under the
     chart, so it takes the line's own vertical rhythm. */
  .lbl .running{margin-top:0;margin-right:8px}
  .rdot{width:7px;height:7px;border-radius:50%;background:${RUNNING_COLOR};flex:none}
  .cells{display:grid;gap:1px;margin-top:10px}
  .cell{aspect-ratio:1;border-radius:1px}
  a.cell{display:block}
  a.cell:hover{outline:1px solid #6ea8fe;outline-offset:-1px}
  /* The dot is drawn by its own layer so each status can take a shape as well
     as a color. The shape carries the same signal the color does, which is
     what a viewer who cannot separate the hues reads instead. */
  .dot{width:10px;height:10px;display:inline-block;flex:none;position:relative}
  .dot::before{content:"";position:absolute;inset:0}
  ${DOT_RULES}
  a.tile.link{display:block;text-decoration:none;color:inherit;cursor:pointer;transition:border-color .12s}
  a.tile.link:hover{border-color:#3a4150}
  .evscroll{max-height:340px;overflow:auto}
  .ev{display:flex;align-items:center;gap:11px;padding:6px 0;font-size:13px;border-top:1px solid rgba(255,255,255,.09)}.ev:first-child{border-top:0}
  .ev .t{color:#9ba3b0;min-width:54px;flex:none}
  .evtxt{color:inherit;text-decoration:none;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:color .1s}
  .evtxt:hover{color:#fff}
  .evdur{color:#a1a9b6;text-decoration:none;text-align:right;min-width:64px;flex:none;font-variant-numeric:tabular-nums}
  a.evdur:hover{color:#6ea8fe}
  .evarrow{color:rgba(255,255,255,.40);text-decoration:none;flex:none;font-size:11px;transition:color .1s}
  .evarrow:hover{color:#8a93a5}
  .swatch{display:inline-block;width:8px;height:8px;border-radius:2px;vertical-align:middle}
  .note{font-size:11px;color:#666c76;margin-top:14px}
  code{background:#1b1e24;padding:1px 5px;border-radius:4px}
</style></head><body>
  <div class="top">
    <div class="brand"><b>Fabric wall</b><span class="badge" id="livebadge">● LIVE</span><span>go/fabricwall</span></div>
    <div class="live"><span class="dot green" id="freshdot"></span> <span id="agotext">updated ${ago}s ago</span></div>
  </div>
  <div class="grid" id="dashboard-grid">${gridHtml}</div>
  <div id="dashboard-wide">${wideHtml}</div>
<script>
  const REFRESH = ${refreshMs};
  const RED_AFTER = REFRESH + ${STALE_GRACE_MS};
  const SHELL_VERSION = ${JSON.stringify(shellVersion)};
  const COL = ${
    JSON.stringify({
      green: STATUS_COLOR.good,
      amber: STATUS_COLOR.warn,
      red: STATUS_COLOR.bad,
    })
  };
  const FAVICONS = ${FAVICON_PNG_HREFS};
  const FAVICON_CRY_AFTER_MS = ${FAVICON_CRY_AFTER_MS};
  const paintStatusFavicon = ${PAINT_STATUS_FAVICON};
  const liveUpdateStream = ${LIVE_UPDATE_STREAM};
  const badge = document.getElementById('livebadge');
  const dot = document.getElementById('freshdot');
  const agotext = document.getElementById('agotext');
  ${formatViewerTimes.toString()}
  formatViewerTimes();
  const grid = document.getElementById('dashboard-grid');
  const wide = document.getElementById('dashboard-wide');
  let base = ${ago};
  let t0 = Date.now();
  let faviconServerRedSince = ${serverRedSince};
  let faviconServerRedAgeMs = ${serverRedAgeMs};
  let faviconStartedAt = performance.now();
  function paint() {
    const now = Date.now();
    const ago = base + Math.floor((now - t0) / 1000);
    agotext.textContent = 'updated ' + ago + 's ago';
    // Fresh up to the refresh interval, then orange for 10s, then red.
    const state = ago * 1000 <= REFRESH ? 'green' : ago * 1000 <= RED_AFTER ? 'amber' : 'red';
    dot.className = 'dot ' + state;
    agotext.style.color = COL[state];
    // The badge says which of the two the stale data means: the server is there
    // and has nothing new, or the page cannot hear it.
    badge.textContent = updates.check(now) ? '● LIVE' : '● OFFLINE';
    // LIVE badge: green only when fresh AND no tile is gray; gray if a tile is gray;
    // when stale, the border takes the orange/red and the contents go gray.
    const anyGray = document.querySelector('.tile.unknown') !== null;
    if (state !== 'green') { badge.style.borderColor = COL[state]; badge.style.color = '${STATUS_COLOR.unknown}'; }
    else if (anyGray) { badge.style.borderColor = '${STATUS_COLOR.unknown}'; badge.style.color = '${STATUS_COLOR.unknown}'; }
    else { badge.style.borderColor = '${STATUS_TEXT.good}'; badge.style.color = '${STATUS_TEXT.good}'; }
    paintStatusFavicon(
      FAVICONS,
      FAVICON_CRY_AFTER_MS,
      faviconServerRedSince,
      faviconServerRedAgeMs,
      faviconStartedAt,
    );
  }
  function reconcileTiles(container, html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    formatViewerTimes(template.content.querySelectorAll('time[data-viewer-time][datetime]'));
    const currentById = new Map(Array.from(container.children).map((tile) => [tile.dataset.tileId, tile]));
    const desired = Array.from(template.content.children).map((next) => {
      const current = currentById.get(next.dataset.tileId);
      if (!current) return next;
      currentById.delete(next.dataset.tileId);
      if (current.outerHTML === next.outerHTML) return current;

      const scrollTop = current.querySelector('.evscroll')?.scrollTop;
      const active = document.activeElement;
      const rootFocused = active === current;
      const focusedHref = current.contains(active) && active instanceof HTMLAnchorElement ? active.href : null;
      const focusedKey = current.contains(active) && active instanceof HTMLAnchorElement
        ? active.dataset.focusKey ?? null
        : null;
      current.replaceWith(next);
      const nextScroller = next.querySelector('.evscroll');
      if (scrollTop !== undefined && nextScroller) nextScroller.scrollTop = scrollTop;
      if (rootFocused) next.focus({ preventScroll: true });
      else if (focusedHref) {
        const links = Array.from(next.querySelectorAll('a'));
        const replacement = focusedKey
          ? links.find((link) => link.dataset.focusKey === focusedKey)
          : undefined;
        (replacement ?? links.find((link) => link.href === focusedHref))?.focus({ preventScroll: true });
      }
      return next;
    });
    for (const obsolete of currentById.values()) obsolete.remove();
    desired.forEach((tile, index) => {
      const atIndex = container.children[index];
      if (atIndex !== tile) container.insertBefore(tile, atIndex ?? null);
    });
  }
  const updates = liveUpdateStream(RED_AFTER, () => {
    const es = new EventSource('/events');
    // The connection's own events repaint, so the badge follows the connection
    // as it changes.
    const alive = () => { updates.heard(Date.now()); paint(); };
    es.addEventListener('open', alive);
    es.addEventListener('ping', alive);
    es.addEventListener('error', () => { updates.lost(); paint(); });
    es.addEventListener('update', (e) => {
      updates.heard(Date.now());
      const update = JSON.parse(e.data);
      if (update.shellVersion !== SHELL_VERSION) { location.reload(); return; }
      reconcileTiles(grid, update.gridHtml);
      reconcileTiles(wide, update.wideHtml);
      base = update.ageSeconds;
      t0 = Date.now();
      faviconServerRedSince = update.faviconRedSince;
      faviconServerRedAgeMs = update.faviconRedAgeMs;
      faviconStartedAt = performance.now();
      paint();
    });
    return es;
  });
  paint();
  setInterval(paint, 1000);
  // A background tab's timers are throttled to about one a minute, and a
  // sleeping machine's stop altogether. These two events fire as the page comes
  // back into use, which is when someone is there to read it.
  document.addEventListener('visibilitychange', paint);
  addEventListener('online', paint);
</script></body></html>`;
}

export function shell(
  gridHtml: string,
  wideHtml: string,
  ago: number,
  refreshMs: number,
  shellVersion: string,
  status: FaviconStatus,
  serverRedSince: number | null = null,
  serverRedAgeMs: number | null = null,
): string {
  return renderShell(
    gridHtml,
    wideHtml,
    ago,
    refreshMs,
    shellVersion,
    status,
    serverRedSince,
    serverRedAgeMs,
  );
}
