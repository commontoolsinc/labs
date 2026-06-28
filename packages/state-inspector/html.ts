// The visual surface — a self-contained HTML inspector over the JSON the other
// commands already emit. No server, no build step, no external deps: one file a
// teammate opens in a browser. It bundles a space's summary, fluent entity list,
// resolved pieces, entity graph, and growth timeline, then renders an interactive
// page (tabs, entity filter, per-piece graph neighborhood, growth sparkline).

import type { SpaceDb } from "./db.ts";
import { type SpaceSummary, summarizeSpace } from "./queries.ts";
import {
  buildModuleIndex,
  describePiece,
  type EntityModel,
  listEntityModels,
  type PieceModel,
} from "./model.ts";
import { buildSpaceGraph, type SpaceGraph } from "./graph.ts";
import { spaceTimeline, type SpaceTimelineEntry } from "./timetravel.ts";

export interface InspectorBundle {
  space: string;
  generatedAt: string;
  summary: SpaceSummary;
  entities: EntityModel[];
  pieces: PieceModel[];
  graph: SpaceGraph;
  timeline: SpaceTimelineEntry[];
}

/** Assemble everything the HTML page needs from one space DB. */
export function buildInspectorBundle(
  space: SpaceDb,
  opts: { branch?: string; scope?: string; generatedAt?: string } = {},
): InspectorBundle {
  const branch = opts.branch ?? "";
  const scope = opts.scope ?? "space";
  const did = (space.path.split("/").pop() ?? "").replace(/\.sqlite$/, "");

  const summary = summarizeSpace(space);
  const entities = listEntityModels(space, { branch, scope });
  const moduleIndex = buildModuleIndex(space, { branch, scope });
  const pieces = entities
    .filter((e) => e.kind === "piece")
    .map((e) => describePiece(space, e.id, { branch, scope, moduleIndex }))
    .filter((p): p is PieceModel => !("error" in p));
  const graph = buildSpaceGraph(space, { branch, scope });
  const timeline = spaceTimeline(space, { branch, scope });

  return {
    space: did,
    generatedAt: opts.generatedAt ?? "",
    summary,
    entities,
    pieces,
    graph,
    timeline,
  };
}

/** Embed JSON safely inside an HTML <script> block. */
function safeJson(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

const STYLE = `
:root {
  --bg: #ffffff; --fg: #1f2937; --muted: #6b7280; --line: #e5e7eb;
  --card: #f9fafb; --accent: #2563eb;
  --piece: #f59e0b; --module: #3b82f6; --stream: #ec4899;
  --schema: #8b5cf6; --owned: #10b981; --free: #9ca3af; --unknown: #d1d5db;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0b0f17; --fg: #e5e7eb; --muted: #9ca3af; --line: #1f2937;
    --card: #111827; --accent: #60a5fa;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
header { padding: 16px 20px; border-bottom: 1px solid var(--line); }
header h1 { margin: 0 0 4px; font-size: 16px; }
header .did { color: var(--muted); word-break: break-all; }
header .stats { margin-top: 8px; color: var(--muted); font-size: 12px; }
nav { display: flex; gap: 2px; padding: 0 20px; border-bottom: 1px solid var(--line);
  position: sticky; top: 0; background: var(--bg); z-index: 2; flex-wrap: wrap; }
nav button { border: 0; background: none; color: var(--muted); padding: 10px 14px;
  cursor: pointer; font: inherit; border-bottom: 2px solid transparent; }
nav button.active { color: var(--fg); border-bottom-color: var(--accent); }
main { padding: 16px 20px; }
section { display: none; } section.active { display: block; }
.kind { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 11px;
  color: #fff; }
.kind.piece { background: var(--piece); } .kind.module { background: var(--module); }
.kind.stream { background: var(--stream); } .kind.schema { background: var(--schema); }
.kind.owned-cell { background: var(--owned); } .kind.free-cell { background: var(--free); }
.kind.unknown { background: var(--unknown); color: #111; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line);
  white-space: nowrap; }
th { color: var(--muted); cursor: pointer; position: sticky; top: 41px; background: var(--bg); }
td.id, td.label { font-family: ui-monospace, monospace; }
td.num { text-align: right; }
.controls { margin-bottom: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
input, select { background: var(--card); color: var(--fg); border: 1px solid var(--line);
  border-radius: 6px; padding: 6px 8px; font: inherit; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px;
  padding: 12px 14px; margin-bottom: 10px; }
.card h3 { margin: 0 0 6px; font-size: 14px; }
.card .row { display: flex; gap: 8px; margin: 2px 0; }
.card .k { color: var(--muted); min-width: 72px; }
.card .v { word-break: break-all; }
.cells { margin-top: 6px; }
.cells .cell { font-size: 12px; color: var(--muted); padding: 1px 0; }
.muted { color: var(--muted); }
svg { max-width: 100%; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
.legend { font-size: 11px; color: var(--muted); margin: 8px 0; display: flex; gap: 14px; flex-wrap: wrap; }
.legend span::before { content: "●"; margin-right: 4px; }
pre { background: var(--card); border: 1px solid var(--line); border-radius: 8px;
  padding: 10px; overflow: auto; font-size: 11px; }
`;

const APP = String.raw`
const DATA = JSON.parse(document.getElementById("bundle").textContent);
const KIND_COLOR = { piece:"var(--piece)", module:"var(--module)", stream:"var(--stream)",
  schema:"var(--schema)", "owned-cell":"var(--owned)", "free-cell":"var(--free)", unknown:"var(--unknown)" };
const EDGE_COLOR = { pattern:"#2563eb", argument:"#16a34a", owns:"#6b7280", link:"#9ca3af" };
const $ = (s, r=document) => r.querySelector(s);
const el = (t, props={}, kids=[]) => {
  const n = document.createElement(t);
  for (const [k,v] of Object.entries(props)) {
    if (k === "class") n.className = v; else if (k === "text") n.textContent = v; else n.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) n.append(c);
  return n;
};
const short = (id) => id && id.length > 16 ? id.slice(0,8)+"…"+id.slice(-6) : id;

// --- tabs ---
for (const b of document.querySelectorAll("nav button")) {
  b.onclick = () => {
    document.querySelectorAll("nav button").forEach(x => x.classList.toggle("active", x===b));
    document.querySelectorAll("section").forEach(s => s.classList.toggle("active", s.id===b.dataset.tab));
    if (b.dataset.tab === "graph") drawGraph();
  };
}

// --- entities table ---
function renderEntities() {
  const kindSel = $("#ent-kind"), q = $("#ent-q"), tbody = $("#ent-body");
  const draw = () => {
    const k = kindSel.value, term = q.value.toLowerCase();
    tbody.innerHTML = "";
    let rows = DATA.entities;
    if (k) rows = rows.filter(e => e.kind === k);
    if (term) rows = rows.filter(e => (e.label+" "+e.id).toLowerCase().includes(term));
    for (const e of rows.slice(0, 2000)) {
      tbody.append(el("tr", {}, [
        el("td", {}, el("span", { class:"kind "+e.kind, text:e.kind })),
        el("td", { class:"label", text:e.label }),
        el("td", { text: e.owned ? "↳" : "" }),
        el("td", { class:"num", text: String(e.revisions ?? 0) }),
        el("td", { class:"num", text: String(e.links ?? 0) }),
        el("td", { class:"id muted", text: short(e.id) }),
      ]));
    }
    $("#ent-count").textContent = rows.length + " entities";
  };
  kindSel.onchange = draw; q.oninput = draw;
  draw();
}

// --- pieces ---
function renderPieces() {
  const host = $("#pieces-list");
  if (!DATA.pieces.length) { host.append(el("p", { class:"muted", text:"(no pieces)" })); return; }
  for (const p of DATA.pieces) {
    const rows = [];
    const add = (k, v) => rows.push(el("div", { class:"row" }, [
      el("span", { class:"k", text:k }), el("span", { class:"v", text:v }) ]));
    if (p.pattern) add("pattern", (p.pattern.filename || "(unresolved)") +
      (p.pattern.symbol ? " · "+p.pattern.symbol : "") +
      (p.pattern.codeLines ? " · "+p.pattern.codeLines+" lines" : ""));
    if (p.input) add("input", p.input.summary + "  " + short(p.input.id));
    add("result", "{" + p.resultKeys.join(", ") + "}");
    if (p.schemaKeys.length) add("schema", "{" + p.schemaKeys.join(", ") + "}");
    const cells = el("div", { class:"cells" });
    for (const c of p.ownedCells) {
      cells.append(el("div", { class:"cell", text: "• " + c.kind + "  " + c.summary }));
    }
    host.append(el("div", { class:"card" }, [
      el("h3", {}, [ el("span", { class:"kind piece", text:"piece" }),
        document.createTextNode("  " + p.name) ]),
      ...rows,
      p.ownedCells.length ? el("div", { class:"k", text: p.ownedCells.length+" owned cells" }) : "",
      cells,
    ]));
  }
}

// --- timeline sparkline ---
function renderTimeline() {
  const t = DATA.timeline;
  const host = $("#timeline-body");
  if (!t.length) { host.append(el("p", { class:"muted", text:"(no commits)" })); return; }
  const W = 720, H = 160, pad = 24;
  const maxCum = Math.max(...t.map(e => e.cumulativeEntities), 1);
  const x = i => pad + (W-2*pad) * (t.length<2?0:i/(t.length-1));
  const y = v => H-pad - (H-2*pad) * (v/maxCum);
  let path = "";
  t.forEach((e,i) => path += (i?" L":"M") + x(i).toFixed(1) + " " + y(e.cumulativeEntities).toFixed(1));
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 "+W+" "+H); svg.setAttribute("width", W);
  const mk = (t2, a) => { const n = document.createElementNS(ns, t2);
    for (const [k,v] of Object.entries(a)) n.setAttribute(k, v); return n; };
  svg.append(mk("path", { d: path, fill:"none", stroke:"var(--accent)", "stroke-width":"2" }));
  t.forEach((e,i) => { if (e.created>0) svg.append(mk("circle",
    { cx:x(i), cy:y(e.cumulativeEntities), r:"2.5", fill:"var(--accent)" })); });
  host.append(svg);
  host.append(el("p", { class:"muted", text:
    t.length+" commits · "+maxCum+" entities at head · peaks mark commits that created entities" }));
  // recent commits table
  const tb = el("tbody");
  for (const e of t.slice(-40).reverse()) {
    tb.append(el("tr", {}, [
      el("td", { text: "#"+e.commitSeq }),
      el("td", { class:"num", text: "+"+e.created }),
      el("td", { class:"num", text: String(e.touched) }),
      el("td", { class:"num", text: "Σ"+e.cumulativeEntities }),
      el("td", { class:"muted", text: e.createdAt }),
    ]));
  }
  host.append(el("table", {}, [ el("thead", {}, el("tr", {}, [
    el("th",{text:"commit"}), el("th",{text:"new"}), el("th",{text:"touched"}),
    el("th",{text:"total"}), el("th",{text:"at"}) ])), tb ]));
}

// --- graph (per-piece neighborhood) ---
let graphDrawn = false;
function drawGraph() {
  if (graphDrawn) return; graphDrawn = true;
  const sel = $("#graph-root");
  const pieces = DATA.graph.nodes.filter(n => n.kind === "piece");
  for (const p of pieces) sel.append(el("option", { value:p.id, text:p.label+" ("+short(p.id)+")" }));
  sel.onchange = () => layout(sel.value);
  if (pieces.length) layout(pieces[0].id);
  else $("#graph-canvas").append(el("p",{class:"muted",text:"(no pieces to root a graph)"}));
}
function neighborhood(rootId, depth) {
  const adj = new Map();
  for (const e of DATA.graph.edges) {
    (adj.get(e.from) ?? adj.set(e.from,[]).get(e.from)).push([e.to, e]);
    (adj.get(e.to) ?? adj.set(e.to,[]).get(e.to)).push([e.from, e]);
  }
  const dist = new Map([[rootId,0]]); let frontier=[rootId];
  for (let d=0; d<depth; d++) { const nx=[];
    for (const n of frontier) for (const [m] of (adj.get(n)||[]))
      if (!dist.has(m)) { dist.set(m, d+1); nx.push(m); }
    frontier = nx; }
  const nodes = DATA.graph.nodes.filter(n => dist.has(n.id));
  const edges = DATA.graph.edges.filter(e => dist.has(e.from) && dist.has(e.to));
  return { nodes, edges, dist };
}
function layout(rootId) {
  const depth = +$("#graph-depth").value;
  const { nodes, edges, dist } = neighborhood(rootId, depth);
  const ns = "http://www.w3.org/2000/svg";
  const byLayer = new Map();
  for (const n of nodes) { const d = dist.get(n.id);
    (byLayer.get(d) ?? byLayer.set(d,[]).get(d)).push(n); }
  const colW = 230, rowH = 56, padX = 20, padY = 30;
  const pos = new Map();
  const maxRows = Math.max(...[...byLayer.values()].map(a => a.length), 1);
  const H = padY*2 + maxRows*rowH, W = padX*2 + (byLayer.size)*colW;
  for (const [d, arr] of byLayer) arr.forEach((n,i) =>
    pos.set(n.id, { x: padX + d*colW + 60, y: padY + (i+0.5)*(H-2*padY)/arr.length }));
  const svg = document.createElementNS(ns,"svg");
  svg.setAttribute("viewBox", "0 0 "+W+" "+H); svg.setAttribute("width", W);
  const mk = (t,a,kids=[]) => { const e=document.createElementNS(ns,t);
    for (const [k,v] of Object.entries(a)) e.setAttribute(k,v);
    for (const c of [].concat(kids)) e.append(c); return e; };
  for (const e of edges) {
    const a = pos.get(e.from), b = pos.get(e.to); if (!a||!b) continue;
    svg.append(mk("line", { x1:a.x, y1:a.y, x2:b.x, y2:b.y,
      stroke: EDGE_COLOR[e.kind]||"#999", "stroke-width": e.kind==="pattern"?"2":"1",
      "stroke-dasharray": e.kind==="link"?"4 3":"" }));
  }
  for (const n of nodes) {
    const p = pos.get(n.id); const isRoot = n.id===rootId;
    svg.append(mk("circle", { cx:p.x, cy:p.y, r: isRoot?"8":"6",
      fill: KIND_COLOR[n.kind]||"#999", stroke: isRoot?"var(--fg)":"none", "stroke-width":"2" }));
    const label = (n.label.length>20?n.label.slice(0,19)+"…":n.label);
    svg.append(mk("text", { x:p.x+11, y:p.y+4, "font-size":"10", fill:"var(--fg)" },
      document.createTextNode(label)));
  }
  const canvas = $("#graph-canvas"); canvas.innerHTML = ""; canvas.append(svg);
}
$("#graph-depth") && ($("#graph-depth").onchange = () => { const s=$("#graph-root"); if (s.value) layout(s.value); });

renderEntities(); renderPieces(); renderTimeline();
`;

const KINDS = [
  "piece",
  "module",
  "stream",
  "schema",
  "owned-cell",
  "free-cell",
  "unknown",
];

/** Render a self-contained HTML inspector for a bundle. */
export function renderInspectorHtml(bundle: InspectorBundle): string {
  const s = bundle.summary;
  const kindOpts = KINDS.map((k) => `<option value="${k}">${k}</option>`).join(
    "",
  );
  const legend = KINDS.map((k) =>
    `<span style="color:var(--${
      k === "owned-cell" ? "owned" : k === "free-cell" ? "free" : k
    })">${k}</span>`
  ).join("");
  const opsLine = Object.entries(s.ops).map(([k, v]) => `${k}=${v}`).join(" ");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>state-inspector · ${bundle.space}</title>
<style>${STYLE}</style></head>
<body>
<header>
  <h1>state-inspector</h1>
  <div class="did">${bundle.space}</div>
  <div class="stats">
    ${s.entities} entities · ${s.commits} commits · ${s.sessions} sessions ·
    ops: ${opsLine}${
    bundle.generatedAt ? ` · generated ${bundle.generatedAt}` : ""
  }
  </div>
</header>
<nav>
  <button class="active" data-tab="overview">Overview</button>
  <button data-tab="pieces">Pieces (${bundle.pieces.length})</button>
  <button data-tab="entities">Entities (${bundle.entities.length})</button>
  <button data-tab="graph">Graph</button>
  <button data-tab="timeline">Timeline</button>
</nav>
<main>
  <section id="overview" class="active">
    <div class="card">
      <h3>What's in here</h3>
      <div class="legend">${legend}</div>
      <div id="overview-counts"></div>
    </div>
    <div class="card">
      <h3>Reading this</h3>
      <p class="muted">A <b>piece</b> is a running pattern instance (a result cell
      with lineage). It owns <b>cells</b> and <b>streams</b>, instantiates a
      <b>module</b> (pattern source) via patternIdentity, and takes an input cell
      (argument). Free cells belong to no piece. See the Pieces tab for the
      resolved anatomy, Graph for relationships, Timeline for how it grew.</p>
    </div>
  </section>
  <section id="pieces"><div id="pieces-list"></div></section>
  <section id="entities">
    <div class="controls">
      <select id="ent-kind"><option value="">all kinds</option>${kindOpts}</select>
      <input id="ent-q" placeholder="filter by label or id" size="28">
      <span class="muted" id="ent-count"></span>
    </div>
    <table>
      <thead><tr><th>kind</th><th>label</th><th>own</th><th>revs</th><th>links</th><th>id</th></tr></thead>
      <tbody id="ent-body"></tbody>
    </table>
  </section>
  <section id="graph">
    <div class="controls">
      <label class="muted">root piece</label>
      <select id="graph-root"></select>
      <label class="muted">depth</label>
      <select id="graph-depth"><option>1</option><option selected>2</option><option>3</option></select>
    </div>
    <div class="legend">
      <span style="color:#2563eb">pattern</span>
      <span style="color:#16a34a">argument</span>
      <span style="color:#6b7280">owns</span>
      <span style="color:#9ca3af">link</span>
    </div>
    <div id="graph-canvas"></div>
  </section>
  <section id="timeline"><div id="timeline-body"></div></section>
</main>
<script id="bundle" type="application/json">${safeJson(bundle)}</script>
<script id="counts" type="application/json">${
    safeJson(bundle.graph.stats.nodesByKind)
  }</script>
<script>
${APP}
(function(){
  const counts = JSON.parse(document.getElementById("counts").textContent);
  const host = document.getElementById("overview-counts");
  for (const [k,n] of Object.entries(counts)) {
    const d = document.createElement("div"); d.className = "row";
    d.innerHTML = '<span class="kind '+k+'">'+k+'</span> <span style="margin-left:8px">'+n+'</span>';
    host.append(d);
  }
})();
</script>
</body></html>`;
}
