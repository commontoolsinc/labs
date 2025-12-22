import { css, html, LitElement, svg, TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import dagre from "dagre";
import type {
  DebuggerController, 
} from "../lib/debugger-controller.ts";
import type { SchedulerGraphNode } from "@commontools/runner";

interface LayoutNode {
  id: string;
  label: string;
  type: "effect" | "computation";
  x: number;
  y: number;
  width: number;
  height: number;
  stats?: SchedulerGraphNode["stats"];
  isDirty: boolean;
  isPending: boolean;
}

interface LayoutEdge {
  id: string;
  from: string;
  to: string;
  cells: string[];
  isHistorical: boolean;
}

const NODE_WIDTH = 140;
const NODE_HEIGHT = 36;

/**
 * Scheduler Graph visualization component.
 * Shows dependency graph with effects and computations.
 */
export class XSchedulerGraph extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    .toolbar {
      display: flex;
      gap: 0.5rem;
      padding: 0.5rem 1rem;
      background: #1e293b;
      border-bottom: 1px solid #334155;
      align-items: center;
      flex-shrink: 0;
    }

    .toggle-group {
      display: flex;
      gap: 0;
    }

    .toggle-button {
      padding: 0.375rem 0.75rem;
      background: #334155;
      border: 1px solid #475569;
      color: #94a3b8;
      font-size: 0.75rem;
      font-family: monospace;
      cursor: pointer;
      transition: all 0.2s;
    }

    .toggle-button:first-child {
      border-radius: 0.375rem 0 0 0.375rem;
    }

    .toggle-button:last-child {
      border-radius: 0 0.375rem 0.375rem 0;
      border-left: none;
    }

    .toggle-button:hover {
      background: #475569;
      color: white;
    }

    .toggle-button.active {
      background: #3b82f6;
      border-color: #3b82f6;
      color: white;
    }

    .action-button {
      padding: 0.375rem 0.75rem;
      background: #334155;
      border: 1px solid #475569;
      border-radius: 0.375rem;
      color: #94a3b8;
      font-size: 0.75rem;
      font-family: monospace;
      cursor: pointer;
      transition: all 0.2s;
    }

    .action-button:hover {
      background: #475569;
      color: white;
    }

    .stats {
      margin-left: auto;
      display: flex;
      gap: 1rem;
      color: #94a3b8;
      font-size: 0.6875rem;
      font-family: monospace;
    }

    .stat-value {
      color: #cbd5e1;
    }

    .graph-container {
      flex: 1;
      overflow: auto;
      position: relative;
      background: #0f172a;
    }

    .graph-svg {
      display: block;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #64748b;
      font-size: 0.875rem;
      gap: 1rem;
    }

    /* Node styles */
    .node-group {
      cursor: pointer;
    }

    .node-rect {
      stroke: #475569;
      stroke-width: 1;
      rx: 4;
      transition: filter 0.3s ease-out;
    }

    .node-effect .node-rect {
      fill: #1e40af; /* blue-800 */
    }

    .node-computation .node-rect {
      fill: #5b21b6; /* violet-800 */
    }

    .node-dirty .node-rect {
      fill: #78350f; /* amber-900 */
    }

    .node-pending .node-rect {
      stroke: #fbbf24;
      stroke-width: 2;
    }

    .node-label {
      fill: white;
      font-size: 10px;
      font-family: monospace;
      pointer-events: none;
    }

    .node-type-badge {
      fill: rgba(255, 255, 255, 0.3);
      font-size: 8px;
      font-family: monospace;
      pointer-events: none;
    }

    .node-stats {
      fill: rgba(255, 255, 255, 0.6);
      font-size: 8px;
      font-family: monospace;
      pointer-events: none;
    }

    /* Edge styles */
    .edge-current {
      stroke: #64748b;
      stroke-width: 1.5;
      fill: none;
    }

    .edge-historical {
      stroke: #475569;
      stroke-width: 1;
      stroke-dasharray: 4 2;
      fill: none;
    }

    .edge-path {
      cursor: pointer;
      transition: stroke 0.2s;
    }

    .edge-path:hover {
      stroke: #f59e0b;
      stroke-width: 2;
    }

    .arrow-marker {
      fill: #64748b;
    }

    /* Tooltip */
    .tooltip {
      position: absolute;
      background: #1e293b;
      border: 1px solid #475569;
      border-radius: 0.375rem;
      padding: 0.5rem;
      font-size: 0.6875rem;
      color: #cbd5e1;
      max-width: 300px;
      z-index: 100;
      pointer-events: none;
      font-family: monospace;
    }

    .tooltip-title {
      font-weight: 600;
      margin-bottom: 0.25rem;
      color: #e2e8f0;
    }

    .tooltip-cells {
      color: #94a3b8;
    }

    .tooltip-cell {
      padding: 0.125rem 0;
      word-break: break-all;
    }

    /* Glow animation */
    @keyframes node-glow {
      0% {
        filter: drop-shadow(0 0 8px currentColor);
      }
      100% {
        filter: drop-shadow(0 0 0 transparent);
      }
    }

    .node-triggered .node-rect {
      animation: node-glow 2s ease-out;
    }

    .node-effect.node-triggered {
      color: #3b82f6;
    }

    .node-computation.node-triggered {
      color: #8b5cf6;
    }
  `;

  @property({ attribute: false })
  debuggerController?: DebuggerController;

  @state()
  private layoutNodes = new Map<string, LayoutNode>();

  @state()
  private layoutEdges: LayoutEdge[] = [];

  @state()
  private svgWidth = 800;

  @state()
  private svgHeight = 400;

  @state()
  private selectedEdge: LayoutEdge | null = null;

  @state()
  private tooltipPosition = { x: 0, y: 0 };

  @state()
  private triggeredNodes = new Map<string, number>(); // id -> timestamp

  @state()
  private isPullMode = true;

  private lastGraphVersion = -1;

  override connectedCallback() {
    super.connectedCallback();
    this.updateLayout();
  }

  override updated(changedProperties: Map<string, unknown>) {
    super.updated(changedProperties);

    // Check if we need to update the graph
    if (this.debuggerController) {
      const currentVersion = this.debuggerController.getGraphUpdateVersion();
      if (currentVersion !== this.lastGraphVersion) {
        this.lastGraphVersion = currentVersion;
        this.updateLayout();
      }
    }
  }

  private updateLayout(): void {
    if (!this.debuggerController) return;

    const graphData = this.debuggerController.getGraphWithHistory();
    if (!graphData) {
      this.layoutNodes = new Map();
      this.layoutEdges = [];
      return;
    }

    this.isPullMode = graphData.pullMode;

    const g = new dagre.graphlib.Graph();
    g.setGraph({
      rankdir: "TB",
      nodesep: 50,
      ranksep: 70,
      marginx: 20,
      marginy: 20,
    });
    g.setDefaultEdgeLabel(() => ({}));

    // Add nodes
    for (const node of graphData.nodes) {
      g.setNode(node.id, {
        label: this.truncateLabel(node.id),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        type: node.type,
        stats: node.stats,
        isDirty: node.isDirty,
        isPending: node.isPending,
      });
    }

    // Add edges
    for (const edge of graphData.edges) {
      g.setEdge(edge.from, edge.to, { cells: edge.cells });
    }

    // Run layout
    dagre.layout(g);

    // Extract positioned nodes
    const nodes = new Map<string, LayoutNode>();
    for (const nodeId of g.nodes()) {
      const node = g.node(nodeId);
      if (node) {
        const originalNode = graphData.nodes.find((n) => n.id === nodeId);
        nodes.set(nodeId, {
          id: nodeId,
          label: node.label,
          type: node.type as "effect" | "computation",
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
          stats: originalNode?.stats,
          isDirty: originalNode?.isDirty ?? false,
          isPending: originalNode?.isPending ?? false,
        });
      }
    }

    // Extract positioned edges
    const edges: LayoutEdge[] = [];
    for (const e of g.edges()) {
      const edgeData = g.edge(e);
      const originalEdge = graphData.edges.find(
        (edge) => edge.from === e.v && edge.to === e.w,
      );
      edges.push({
        id: `${e.v}->${e.w}`,
        from: e.v,
        to: e.w,
        cells: edgeData?.cells ?? [],
        isHistorical: originalEdge?.isHistorical ?? false,
      });
    }

    // Calculate SVG dimensions
    const graphInfo = g.graph();
    this.svgWidth = Math.max(800, (graphInfo.width ?? 0) + 40);
    this.svgHeight = Math.max(400, (graphInfo.height ?? 0) + 40);

    this.layoutNodes = nodes;
    this.layoutEdges = edges;
  }

  private truncateLabel(label: string, maxLen = 18): string {
    if (label.length <= maxLen) return label;
    return label.slice(0, maxLen - 2) + "...";
  }

  private handleRefresh(): void {
    this.debuggerController?.requestGraphSnapshot();
  }

  private handleModeToggle(pullMode: boolean): void {
    const runtime = this.debuggerController?.getRuntime();
    if (!runtime) return;

    const rt = runtime.runtime();
    if (!rt) return;

    if (pullMode) {
      rt.scheduler.enablePullMode();
    } else {
      rt.scheduler.disablePullMode();
    }

    this.isPullMode = pullMode;
  }

  private handleEdgeClick(e: MouseEvent, edge: LayoutEdge): void {
    e.stopPropagation();

    if (this.selectedEdge?.id === edge.id) {
      this.selectedEdge = null;
    } else {
      this.selectedEdge = edge;
      this.tooltipPosition = { x: e.clientX, y: e.clientY };
    }
  }

  private handleContainerClick(): void {
    this.selectedEdge = null;
  }

  private renderToolbar(): TemplateResult {
    const nodeCount = this.layoutNodes.size;
    const edgeCount = this.layoutEdges.filter((e) => !e.isHistorical).length;
    const historicalCount = this.layoutEdges.filter((e) => e.isHistorical)
      .length;

    return html`
      <div class="toolbar">
        <div class="toggle-group">
          <button
            type="button"
            class="toggle-button ${this.isPullMode ? "active" : ""}"
            @click="${() => this.handleModeToggle(true)}"
            title="Pull mode: computations run on-demand"
          >
            Pull
          </button>
          <button
            type="button"
            class="toggle-button ${!this.isPullMode ? "active" : ""}"
            @click="${() => this.handleModeToggle(false)}"
            title="Push mode: all triggered actions run immediately"
          >
            Push
          </button>
        </div>

        <button
          type="button"
          class="action-button"
          @click="${this.handleRefresh}"
          title="Refresh graph"
        >
          Refresh
        </button>

        <button
          type="button"
          class="action-button"
          @click="${() => this.debuggerController?.clearHistoricalEdges()}"
          title="Clear historical edges"
        >
          Clear History
        </button>

        <div class="stats">
          <span>Nodes: <span class="stat-value">${nodeCount}</span></span>
          <span>Edges: <span class="stat-value">${edgeCount}</span></span>
          ${historicalCount > 0
            ? html`<span>Historical: <span class="stat-value">${historicalCount}</span></span>`
            : ""}
        </div>
      </div>
    `;
  }

  private renderNode(node: LayoutNode): TemplateResult {
    const isTriggered =
      this.triggeredNodes.has(node.id) &&
      Date.now() - (this.triggeredNodes.get(node.id) ?? 0) < 2000;

    const nodeClass = [
      "node-group",
      `node-${node.type}`,
      node.isDirty ? "node-dirty" : "",
      node.isPending ? "node-pending" : "",
      isTriggered ? "node-triggered" : "",
    ]
      .filter(Boolean)
      .join(" ");

    const x = node.x - node.width / 2;
    const y = node.y - node.height / 2;

    return svg`
      <g
        class="${nodeClass}"
        transform="translate(${x}, ${y})"
      >
        <rect
          class="node-rect"
          width="${node.width}"
          height="${node.height}"
        />
        <text
          class="node-type-badge"
          x="4"
          y="10"
        >
          ${node.type === "effect" ? "E" : "C"}
        </text>
        <text
          class="node-label"
          x="${node.width / 2}"
          y="${node.height / 2 + 3}"
          text-anchor="middle"
        >
          ${node.label}
        </text>
        ${node.stats
          ? svg`
          <text
            class="node-stats"
            x="${node.width - 4}"
            y="${node.height - 4}"
            text-anchor="end"
          >
            ${node.stats.runCount}× ${node.stats.averageTime.toFixed(0)}ms
          </text>
        `
          : ""}
      </g>
    `;
  }

  private renderEdge(edge: LayoutEdge): TemplateResult | null {
    const source = this.layoutNodes.get(edge.from);
    const target = this.layoutNodes.get(edge.to);
    if (!source || !target) return null;

    // Calculate edge path (from bottom of source to top of target)
    const x1 = source.x;
    const y1 = source.y + source.height / 2;
    const x2 = target.x;
    const y2 = target.y - target.height / 2;

    // Simple straight line (could add bezier curves later)
    const path = `M ${x1} ${y1} L ${x2} ${y2}`;

    return svg`
      <path
        class="edge-path ${edge.isHistorical ? "edge-historical" : "edge-current"}"
        d="${path}"
        marker-end="url(#arrowhead)"
        @click="${(e: MouseEvent) => this.handleEdgeClick(e, edge)}"
      />
    `;
  }

  private renderGraph(): TemplateResult {
    if (this.layoutNodes.size === 0) {
      return html`
        <div class="empty-state">
          <div>No graph data available</div>
          <button
            type="button"
            class="action-button"
            @click="${this.handleRefresh}"
          >
            Load Graph
          </button>
        </div>
      `;
    }

    return html`
      <svg
        class="graph-svg"
        width="${this.svgWidth}"
        height="${this.svgHeight}"
        viewBox="0 0 ${this.svgWidth} ${this.svgHeight}"
      >
        <defs>
          <marker
            id="arrowhead"
            markerWidth="10"
            markerHeight="7"
            refX="9"
            refY="3.5"
            orient="auto"
          >
            <polygon class="arrow-marker" points="0 0, 10 3.5, 0 7" />
          </marker>
        </defs>

        <g class="edges">
          ${this.layoutEdges.map((edge) => this.renderEdge(edge))}
        </g>

        <g class="nodes">
          ${[...this.layoutNodes.values()].map((node) => this.renderNode(node))}
        </g>
      </svg>
    `;
  }

  private renderTooltip(): TemplateResult | null {
    if (!this.selectedEdge) return null;

    const fromNode = this.layoutNodes.get(this.selectedEdge.from);
    const toNode = this.layoutNodes.get(this.selectedEdge.to);

    return html`
      <div
        class="tooltip"
        style="left: ${this.tooltipPosition.x + 10}px; top: ${this.tooltipPosition.y + 10}px;"
      >
        <div class="tooltip-title">
          ${fromNode?.label ?? this.selectedEdge.from} →
          ${toNode?.label ?? this.selectedEdge.to}
        </div>
        <div class="tooltip-cells">
          ${this.selectedEdge.cells.length > 0
            ? this.selectedEdge.cells.map(
                (cell) => html`<div class="tooltip-cell">${cell}</div>`,
              )
            : html`<div class="tooltip-cell">(no cells tracked)</div>`}
        </div>
        ${this.selectedEdge.isHistorical
          ? html`<div style="color: #f59e0b; margin-top: 0.25rem;">Historical (no longer active)</div>`
          : ""}
      </div>
    `;
  }

  override render(): TemplateResult {
    return html`
      ${this.renderToolbar()}
      <div class="graph-container" @click="${this.handleContainerClick}">
        ${this.renderGraph()}
        ${this.renderTooltip()}
      </div>
    `;
  }
}

globalThis.customElements.define("x-scheduler-graph", XSchedulerGraph);
