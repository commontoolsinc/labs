/**
 * The data-flow graph: the patterns a run ran, the cells they produced and
 * read, and the routing between them.
 *
 * Laid out left to right by the step each node appeared at, so scrubbing the
 * step slider grows the picture the way the run built it. A pattern is a
 * rectangle and a cell is a rounded one; a solid edge is a pattern producing a
 * cell, a dashed one is a pattern reading it.
 */

import { html, LitElement, nothing, type TemplateResult } from "lit";
import type { ConsoleGraph, ConsoleGraphNode } from "./api.ts";

const NODE_WIDTH = 156;
const NODE_HEIGHT = 40;
const COLUMN_GAP = 76;
const ROW_GAP = 22;
const PADDING = 16;

interface Placed {
  node: ConsoleGraphNode;
  x: number;
  y: number;
}

/**
 * How far along the flow each node sits: a node with nothing feeding it is at
 * rank zero, and every other node sits one past the furthest thing that feeds
 * it. So a pattern and the cell it produced are neighbours, and a cell read by
 * a later pattern pushes that pattern further right — the horizontal axis is
 * the data's path rather than the clock.
 *
 * Dating is not enough on its own to lay this out: a subagent's nodes all
 * carry the parent step that delegated into them, so ranking by step alone
 * would stack a whole child run in one column.
 */
const ranks = (graph: ConsoleGraph): Map<string, number> => {
  const incoming = new Map<string, string[]>();
  for (const node of graph.nodes) {
    incoming.set(node.id, []);
  }
  for (const edge of graph.edges) {
    incoming.get(edge.to)?.push(edge.from);
  }
  const rank = new Map<string, number>();
  const resolve = (id: string, seen: Set<string>): number => {
    const held = rank.get(id);
    if (held !== undefined) {
      return held;
    }
    // A cycle cannot arise from produce/read edges over distinct cells, but
    // ranking must terminate whatever the data says.
    if (seen.has(id)) {
      return 0;
    }
    seen.add(id);
    const feeders = incoming.get(id) ?? [];
    const value = feeders.length === 0
      ? 0
      : Math.max(...feeders.map((from) => resolve(from, seen) + 1));
    rank.set(id, value);
    return value;
  };
  for (const node of graph.nodes) {
    resolve(node.id, new Set());
  }
  return rank;
};

/**
 * Where each node sits: its rank across, and its own order down. Within a
 * column nodes keep the order they appeared in, so reading a column top to
 * bottom is reading the run's own sequence.
 */
const layout = (
  graph: ConsoleGraph,
): { placed: Placed[]; width: number; height: number } => {
  const rank = ranks(graph);
  // Ties are broken numerically: a node id ends in its step, and a plain string
  // comparison would put step 10 above step 7 in the same column.
  const ordered = [...graph.nodes].sort((left, right) =>
    left.atStep === right.atStep
      ? left.id.localeCompare(right.id, undefined, { numeric: true })
      : left.atStep - right.atStep
  );
  const rows = new Map<number, number>();
  const placed = ordered.map((node) => {
    const column = rank.get(node.id) ?? 0;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return {
      node,
      x: PADDING + column * (NODE_WIDTH + COLUMN_GAP),
      y: PADDING + row * (NODE_HEIGHT + ROW_GAP),
    };
  });
  const columns = Math.max(1, ...[...rows.keys()].map((key) => key + 1));
  const tallest = Math.max(1, ...rows.values());
  return {
    placed,
    width: PADDING * 2 + columns * (NODE_WIDTH + COLUMN_GAP) - COLUMN_GAP,
    height: PADDING * 2 + tallest * (NODE_HEIGHT + ROW_GAP) - ROW_GAP,
  };
};

const truncate = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

export class ConsoleGraphView extends LitElement {
  static override properties = {
    graph: { attribute: false },
    selected: { attribute: false },
    focusStep: { attribute: false },
  };

  declare graph: ConsoleGraph | undefined;
  /** The node the reader clicked, whose detail shows beneath the picture. */
  declare selected: string | undefined;
  /** The step the timeline sits on, drawn as the leading edge of the graph. */
  declare focusStep: number | undefined;

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  #node(placed: Placed, leading: boolean): TemplateResult {
    const node = placed.node;
    const isCell = node.kind === "cell";
    const classes = [
      "gnode",
      node.kind,
      node.status ?? "",
      node.id === this.selected ? "chosen" : "",
      leading ? "leading" : "",
    ].filter(Boolean).join(" ");
    return html`
      <g
        class=${classes}
        transform="translate(${placed.x}, ${placed.y})"
        @click=${() =>
          this.selected = this.selected === node.id ? undefined : node.id}
      >
        <rect
          width=${NODE_WIDTH}
          height=${NODE_HEIGHT}
          rx=${isCell ? NODE_HEIGHT / 2 : 6}
        ></rect>
        <text x="10" y="17">${truncate(node.label, 20)}</text>
        <text class="gsub" x="10" y="31">
          ${isCell
            ? node.slug !== undefined ? node.token ?? "" : "cell"
            : `step ${node.atStep}${
              node.status === undefined ? "" : ` · ${node.status}`
            }`}
        </text>
        ${node.confidentiality.length === 0 ? nothing : html`
          <circle class="gatom" cx=${NODE_WIDTH - 12} cy="12" r="4"></circle>
        `}
      </g>
    `;
  }

  #detail(node: ConsoleGraphNode): TemplateResult {
    return html`
      <div class="gdetail">
        <div class="pane-head">
          ${node.kind}
          ${node.status === undefined
            ? nothing
            : html`<span class="badge ${node.status}">${node.status}</span>`}
          ${node.policyDecision === undefined ? nothing : html`
            <span
              class="badge ${node.policyDecision === "denied"
                ? "denied"
                : "ok"}"
            >cfc ${node.policyDecision}</span>
          `}
        </div>
        <table class="handles">
          <tbody>
            ${node.slug === undefined ? nothing : html`
              <tr>
                <td class="handle-at">slug</td>
                <td>${node.slug}</td>
              </tr>
            `}
            ${node.token === undefined ? nothing : html`
              <tr>
                <td class="handle-at">handle</td>
                <td class="handle-token">${node.token}</td>
              </tr>
            `}
            ${node.address === undefined ? nothing : html`
              <tr>
                <td class="handle-at">address</td>
                <td class="handle-ref">${node.address}</td>
              </tr>
            `}
            ${node.patternId === undefined ? nothing : html`
              <tr>
                <td class="handle-at">pattern</td>
                <td class="handle-token">${node.patternId}</td>
              </tr>
            `}
            ${node.disclosure === undefined ? nothing : html`
              <tr>
                <td class="handle-at">disclosure</td>
                <td>
                  ${node.disclosure.valueBytes} B as value ·
                  ${node.disclosure.sealedPositions} sealed
                </td>
              </tr>
            `}
            ${node.confidentiality.length === 0 ? nothing : html`
              <tr>
                <td class="handle-at">labels</td>
                <td class="label-atoms">
                  ${node.confidentiality.map((name) =>
                    html`<span class="atom conf">${name}</span>`
                  )}
                </td>
              </tr>
            `}
            <tr><td class="handle-at">appeared</td><td>step ${node
              .atStep}</td></tr>
          </tbody>
        </table>
      </div>
    `;
  }

  protected override render(): TemplateResult {
    const graph = this.graph;
    if (graph === undefined) {
      return html`<p class="empty">Reading…</p>`;
    }
    if (graph.nodes.length === 0) {
      return html`
        <p class="empty">
          This run ran no pattern and named no cell, so it moved no data.
        </p>
      `;
    }
    const { placed, width, height } = layout(graph);
    const at = new Map(placed.map((entry) => [entry.node.id, entry]));
    const patterns = graph.nodes.filter((node) => node.kind === "pattern");
    const reads = graph.edges.filter((edge) => edge.kind === "reads");
    const chosen = graph.nodes.find((node) => node.id === this.selected);
    return html`
      <div class="gsummary">
        <span class="badge ${reads.length === 0 ? "warn" : "ok"}">
          ${reads.length} read ${reads.length === 1 ? "edge" : "edges"}
        </span>
        <span class="cfc-reasons">
          ${patterns.length} ${patterns.length === 1 ? "pattern" : "patterns"},
          ${graph.nodes.length - patterns.length} cells.
          ${graph.unwiredPatterns === 0
            ? nothing
            : html`${graph.unwiredPatterns} read no cell — built from literals
              rather than composed over references.`}
        </span>
      </div>
      <div class="gcanvas">
        <svg
          width=${width}
          height=${height}
          viewBox="0 0 ${width} ${height}"
          role="img"
          aria-label="data-flow graph"
        >
          <defs>
            <marker
              id="arrow"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 z"></path>
            </marker>
          </defs>
          ${graph.edges.map((edge) => {
            const from = at.get(edge.from);
            const to = at.get(edge.to);
            if (from === undefined || to === undefined) {
              return nothing;
            }
            const x1 = from.x + NODE_WIDTH;
            const y1 = from.y + NODE_HEIGHT / 2;
            const x2 = to.x;
            const y2 = to.y + NODE_HEIGHT / 2;
            const mid = (x1 + x2) / 2;
            return html`
              <g class="gedge ${edge.kind}">
                <path
                  d="M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}"
                  marker-end="url(#arrow)"
                ></path>
                ${edge.label === undefined ? nothing : html`
                  <text x=${mid} y=${(y1 + y2) / 2 - 4}>${edge.label}</text>
                `}
              </g>
            `;
          })}
          ${placed.map((entry) =>
            this.#node(entry, entry.node.atStep === this.focusStep)
          )}
        </svg>
      </div>
      ${chosen === undefined ? nothing : this.#detail(chosen)}
    `;
  }
}

customElements.define("console-graph-view", ConsoleGraphView);
