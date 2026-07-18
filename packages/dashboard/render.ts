// Uniform rendering: every tile becomes the same markup from its TileView, and
// the shell wraps the grid + wide tiles in the dark page with the SSE client.
import type { TileView } from "./types.ts";
import { durationTag, escapeHtml, STATUS_DOT } from "./lib.ts";
import { REPO } from "./config.ts";

// Open dashboards reload when this changes. Increment it with shell markup,
// styles, client code, or the update payload shape.
export const SHELL_VERSION = 2;

export function renderTile(v: TileView, id?: string, wide = false): string {
  const cls = `tile ${v.status}${v.href ? " link" : ""}${wide ? " wide" : ""}`;
  const key = id ? ` data-tile-id="${escapeHtml(id)}"` : "";
  const dot = `<span class="dot ${STATUS_DOT[v.status]}"></span>`;
  const hint = v.hint ? `<span class="drill">${escapeHtml(v.hint)}</span>` : "";
  const header = `<p class="lbl">${dot} ${escapeHtml(v.label)}<span class="spacer"></span>${v.aside ?? ""}${hint}</p>`;
  const big = v.value !== undefined ? `<p class="big ${v.status}">${v.value}</p>` : "";
  const sub = v.sub ? `<p class="sub">${escapeHtml(v.sub)}</p>` : "";
  // The chart plus its duration label (bottom-left corner, auto-formatted). The
  // relative wrapper positions the duration; a tile with no duration renders extra
  // unwrapped, unchanged. The label describes the chart's span, so it needs a chart
  // to sit in: drawn without one, the wrapper has no height and the label lands on
  // top of the sub line. A tile whose series is too short to plot still reports a
  // span, so this is reachable.
  const body = v.duration && v.extra
    ? `<div style="position:relative">${v.extra}${durationTag(v.duration)}</div>`
    : (v.extra ?? "");
  const inner = `${header}${big}${sub}${body}`;
  if (!v.href) return `<div class="${cls}"${key}>${inner}</div>`;
  const tgt = /^https?:/.test(v.href) ? ` target="_blank" rel="noopener"` : "";
  return `<a class="${cls}"${key} href="${escapeHtml(v.href)}"${tgt}>${inner}</a>`;
}

export function shell(
  gridHtml: string,
  wideHtml: string,
  ago: number,
  refreshMs: number,
  shellVersion: number,
): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fabric wall — LIVE</title>
<style>
  body{margin:0;background:#0d0e11;color:#e7e9ee;font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:18px 20px 26px;max-width:1100px;margin:0 auto}
  .top{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
  .brand b{font-size:16px;font-weight:600}.brand span{font-size:12px;color:#6f757f;margin-left:8px}
  .badge{font-size:11px;color:#62d18d;border:1px solid rgba(67,197,116,.4);border-radius:6px;padding:2px 8px;margin-left:8px}
  .live{font-size:12px;color:#9aa0ab}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-bottom:12px}
  .tile{background:#16181d;border:1px solid #23262d;border-radius:12px;padding:14px 16px}
  .tile.wide{margin-bottom:12px}
  .tile.good,.tile.wide.good{border-color:rgba(67,197,116,.34);background:rgba(67,197,116,.08)}
  .tile.warn,.tile.wide.warn{border-color:rgba(224,168,82,.42);background:rgba(224,168,82,.09)}
  .tile.bad,.tile.wide.bad{border-color:rgba(226,80,74,.5);background:rgba(226,80,74,.11)}
  .tile.unknown,.tile.wide.unknown{border-color:#2f333c}
  .lbl{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#878d97;margin:0 0 7px;display:flex;align-items:center;gap:7px}
  .lbl .spacer{flex:1}
  .drill{font-size:10px;color:#6f757f;letter-spacing:0;text-transform:none}
  .hmtd{font-size:11px;color:#9aa0ab;letter-spacing:0;text-transform:none;font-variant-numeric:tabular-nums;margin-right:8px}
  .big{font-size:30px;font-weight:600;margin:0}
  .big.good{color:#62d18d}.big.warn{color:#f0b968}.big.bad{color:#f0726c}.big.unknown{color:#9aa0ab}
  .sub{font-size:13px;color:#9aa0ab;margin:5px 0 0}
  .running{display:inline-flex;align-items:center;gap:5px;font-size:10px;color:#8a93a5;letter-spacing:.02em;text-transform:none;margin-top:10px}
  .rdot{width:7px;height:7px;border-radius:50%;background:#6ea8fe;flex:none}
  .cells{display:grid;gap:1px;margin-top:10px}
  .cell{aspect-ratio:1;border-radius:1px}
  a.cell{display:block}
  a.cell:hover{outline:1px solid #6ea8fe;outline-offset:-1px}
  .dot{width:9px;height:9px;border-radius:50%;display:inline-block;flex:none}
  .dot.green{background:#43c574}.dot.red{background:#e2504a}.dot.grey{background:#7c828c}.dot.amber{background:#e0a852}.dot.run{background:#6ea8fe}
  a.tile.link{display:block;text-decoration:none;color:inherit;cursor:pointer;transition:border-color .12s}
  a.tile.link:hover{border-color:#3a4150}
  .evscroll{max-height:340px;overflow:auto}
  .ev{display:flex;align-items:center;gap:11px;padding:6px 0;font-size:13px;border-top:1px solid #1c2026}.ev:first-child{border-top:0}
  .ev .t{color:#7d838e;min-width:54px;flex:none}
  .evtxt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  a.ev{color:inherit;text-decoration:none;transition:color .1s}
  a.ev:hover{color:#fff}a.ev:hover .evarrow{color:#8a93a5}
  .evarrow{flex:none;color:#33373f;font-size:11px}
  .swatch{display:inline-block;width:8px;height:8px;border-radius:2px;vertical-align:middle}
  .note{font-size:11px;color:#666c76;margin-top:14px}
  code{background:#1b1e24;padding:1px 5px;border-radius:4px}
</style></head><body>
  <div class="top">
    <div class="brand"><b>Fabric wall</b><span class="badge" id="livebadge">● LIVE</span><span>${escapeHtml(REPO)}</span></div>
    <div class="live"><span class="dot green" id="freshdot"></span> <span id="agotext">updated ${ago}s ago</span></div>
  </div>
  <div class="grid" id="dashboard-grid">${gridHtml}</div>
  <div id="dashboard-wide">${wideHtml}</div>
<script>
  const REFRESH = ${refreshMs};
  const SHELL_VERSION = ${shellVersion};
  const COL = { green: '#43c574', amber: '#e0a852', red: '#e2504a' };
  const badge = document.getElementById('livebadge');
  const dot = document.getElementById('freshdot');
  const agotext = document.getElementById('agotext');
  const grid = document.getElementById('dashboard-grid');
  const wide = document.getElementById('dashboard-wide');
  let base = ${ago};
  let t0 = Date.now();
  function paint() {
    const ago = base + Math.floor((Date.now() - t0) / 1000);
    agotext.textContent = 'updated ' + ago + 's ago';
    // Fresh up to the refresh interval, then orange for 10s, then red.
    const state = ago * 1000 <= REFRESH ? 'green' : ago * 1000 <= REFRESH + 10000 ? 'amber' : 'red';
    dot.className = 'dot ' + state;
    agotext.style.color = COL[state];
    // LIVE badge: green only when fresh AND no tile is gray; gray if a tile is gray;
    // when stale, the border takes the orange/red and the contents go gray.
    const anyGray = document.querySelector('.tile.unknown') !== null;
    if (state !== 'green') { badge.style.borderColor = COL[state]; badge.style.color = '#7c828c'; }
    else if (anyGray) { badge.style.borderColor = '#7c828c'; badge.style.color = '#7c828c'; }
    else { badge.style.borderColor = '#62d18d'; badge.style.color = '#62d18d'; }
  }
  function reconcileTiles(container, html) {
    const template = document.createElement('template');
    template.innerHTML = html;
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
      current.replaceWith(next);
      const nextScroller = next.querySelector('.evscroll');
      if (scrollTop !== undefined && nextScroller) nextScroller.scrollTop = scrollTop;
      if (rootFocused) next.focus({ preventScroll: true });
      else if (focusedHref) {
        Array.from(next.querySelectorAll('a')).find((link) => link.href === focusedHref)?.focus({ preventScroll: true });
      }
      return next;
    });
    for (const obsolete of currentById.values()) obsolete.remove();
    desired.forEach((tile, index) => {
      const atIndex = container.children[index];
      if (atIndex !== tile) container.insertBefore(tile, atIndex ?? null);
    });
  }
  const es = new EventSource('/events');
  es.onmessage = (e) => { if (e.data === 'reload') location.reload(); };
  es.addEventListener('update', (e) => {
    const update = JSON.parse(e.data);
    if (update.shellVersion !== SHELL_VERSION) { location.reload(); return; }
    reconcileTiles(grid, update.gridHtml);
    reconcileTiles(wide, update.wideHtml);
    base = update.ageSeconds;
    t0 = Date.now();
    paint();
  });
  paint();
  setInterval(paint, 1000);
</script></body></html>`;
}
