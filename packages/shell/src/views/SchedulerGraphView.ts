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
  parentId?: string;
  childCount?: number;
  collapsedChildCount?: number; // Number of hidden children when collapsed
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

    .zoom-controls {
      display: flex;
      gap: 0;
    }

    .zoom-button {
      width: 28px;
      height: 28px;
      padding: 0;
      background: #334155;
      border: 1px solid #475569;
      color: #94a3b8;
      font-size: 1rem;
      font-family: monospace;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .zoom-button:first-child {
      border-radius: 0.375rem 0 0 0.375rem;
    }

    .zoom-button:last-child {
      border-radius: 0 0.375rem 0.375rem 0;
      border-left: none;
    }

    .zoom-button:hover {
      background: #475569;
      color: white;
    }

    .zoom-level {
      padding: 0.375rem 0.5rem;
      background: #1e293b;
      border: 1px solid #475569;
      border-left: none;
      color: #cbd5e1;
      font-size: 0.6875rem;
      font-family: monospace;
      cursor: pointer;
      min-width: 48px;
      text-align: center;
    }

    .zoom-level:hover {
      background: #334155;
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

    .node-collapse-toggle {
      fill: rgba(255, 255, 255, 0.5);
      font-size: 12px;
      font-family: monospace;
      cursor: pointer;
      transition: fill 0.2s;
    }

    .node-collapse-toggle:hover {
      fill: white;
    }

    .node-child-count {
      fill: #f59e0b;
      font-size: 8px;
      font-family: monospace;
      pointer-events: none;
    }

    /* Parent group container styles */
    .parent-group-rect {
      fill: rgba(255, 255, 255, 0.03);
      stroke: rgba(255, 255, 255, 0.1);
      stroke-width: 1;
      stroke-dasharray: 4 2;
      rx: 8;
    }

    .parent-group-label {
      fill: rgba(255, 255, 255, 0.3);
      font-size: 9px;
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

    /* Size boost animation for triggered nodes when zoomed out */
    @keyframes node-size-boost {
      0%, 100% {
        transform: scale(1);
      }
      15% {
        transform: scale(2.5);
      }
      85% {
        transform: scale(2.5);
      }
    }

    .node-boosted {
      transform-origin: center center;
      animation: node-size-boost 2s ease-out;
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

  @state()
  private zoomLevel = 1.0;

  @state()
  private collapsedParents = new Set<string>();

  private lastGraphVersion = -1;

  // Minimum effective node size before we boost triggered nodes
  private static readonly READABLE_THRESHOLD = 50;

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

    // Build a map of all nodes and identify which are hidden due to collapsed parents
    const nodeMap = new Map(graphData.nodes.map((n) => [n.id, n]));
    const hiddenNodes = new Set<string>();
    const collapsedChildCounts = new Map<string, number>();

    // Find all nodes that should be hidden (their parent is collapsed)
    for (const node of graphData.nodes) {
      if (node.parentId && this.collapsedParents.has(node.parentId)) {
        hiddenNodes.add(node.id);
        // Count hidden children for the collapsed parent
        collapsedChildCounts.set(
          node.parentId,
          (collapsedChildCounts.get(node.parentId) ?? 0) + 1,
        );
      }
    }

    const g = new dagre.graphlib.Graph();
    g.setGraph({
      rankdir: "TB",
      nodesep: 50,
      ranksep: 70,
      marginx: 20,
      marginy: 20,
    });
    g.setDefaultEdgeLabel(() => ({}));

    // Add nodes (excluding hidden ones)
    for (const node of graphData.nodes) {
      if (hiddenNodes.has(node.id)) continue;

      g.setNode(node.id, {
        label: this.truncateLabel(node.id),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        type: node.type,
        stats: node.stats,
        isDirty: node.isDirty,
        isPending: node.isPending,
        parentId: node.parentId,
        childCount: node.childCount,
      });
    }

    // Add edges (excluding edges to/from hidden nodes)
    for (const edge of graphData.edges) {
      if (hiddenNodes.has(edge.from) || hiddenNodes.has(edge.to)) continue;
      g.setEdge(edge.from, edge.to, { cells: edge.cells });
    }

    // Run layout
    dagre.layout(g);

    // Extract positioned nodes
    const nodes = new Map<string, LayoutNode>();
    for (const nodeId of g.nodes()) {
      const node = g.node(nodeId);
      if (node) {
        const originalNode = nodeMap.get(nodeId);
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
          parentId: originalNode?.parentId,
          childCount: originalNode?.childCount,
          collapsedChildCount: collapsedChildCounts.get(nodeId),
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

  private handleZoomIn(): void {
    this.zoomLevel = Math.min(2.0, this.zoomLevel + 0.25);
  }

  private handleZoomOut(): void {
    this.zoomLevel = Math.max(0.25, this.zoomLevel - 0.25);
  }

  private handleZoomReset(): void {
    this.zoomLevel = 1.0;
  }

  private get effectiveNodeWidth(): number {
    return NODE_WIDTH * this.zoomLevel;
  }

  private get shouldBoostTriggeredNodes(): boolean {
    return this.effectiveNodeWidth < XSchedulerGraph.READABLE_THRESHOLD;
  }

  private handleToggleCollapse(nodeId: string, e: Event): void {
    e.stopPropagation();
    const newCollapsed = new Set(this.collapsedParents);
    if (newCollapsed.has(nodeId)) {
      newCollapsed.delete(nodeId);
    } else {
      newCollapsed.add(nodeId);
    }
    this.collapsedParents = newCollapsed;
    this.updateLayout();
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

        <div class="zoom-controls">
          <button
            type="button"
            class="zoom-button"
            @click="${this.handleZoomOut}"
            title="Zoom out"
          >
            -
          </button>
          <button
            type="button"
            class="zoom-level"
            @click="${this.handleZoomReset}"
            title="Reset zoom"
          >
            ${Math.round(this.zoomLevel * 100)}%
          </button>
          <button
            type="button"
            class="zoom-button"
            @click="${this.handleZoomIn}"
            title="Zoom in"
          >
            +
          </button>
        </div>

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

    // Boost triggered nodes when zoomed out below readable threshold
    const shouldBoost = isTriggered && this.shouldBoostTriggeredNodes;

    const nodeClass = [
      "node-group",
      `node-${node.type}`,
      node.isDirty ? "node-dirty" : "",
      node.isPending ? "node-pending" : "",
      isTriggered ? "node-triggered" : "",
      shouldBoost ? "node-boosted" : "",
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
        ${this.renderCollapseToggle(node)}
        ${this.renderChildCountBadge(node)}
      </g>
    `;
  }

  private renderCollapseToggle(node: LayoutNode): TemplateResult | null {
    // Only show toggle if node has children
    if (!node.childCount || node.childCount === 0) return null;

    const isCollapsed = this.collapsedParents.has(node.id);
    const symbol = isCollapsed ? "+" : "-";

    return svg`
      <text
        class="node-collapse-toggle"
        x="${node.width - 8}"
        y="12"
        text-anchor="middle"
        @click="${(e: Event) => this.handleToggleCollapse(node.id, e)}"
      >
        ${symbol}
      </text>
    `;
  }

  private renderChildCountBadge(node: LayoutNode): TemplateResult | null {
    // Only show badge if this node has collapsed children
    if (!node.collapsedChildCount || node.collapsedChildCount === 0) return null;

    return svg`
      <text
        class="node-child-count"
        x="${node.width / 2}"
        y="${node.height + 12}"
        text-anchor="middle"
      >
        (${node.collapsedChildCount} hidden)
      </text>
    `;
  }

  private computeParentGroups(): Map<
    string,
    { parent: LayoutNode; children: LayoutNode[]; bounds: DOMRect }
  > {
    const groups = new Map<
      string,
      { parent: LayoutNode; children: LayoutNode[]; bounds: DOMRect }
    >();

    // Find all parents that have visible children
    for (const node of this.layoutNodes.values()) {
      if (node.parentId) {
        const parent = this.layoutNodes.get(node.parentId);
        if (parent) {
          if (!groups.has(node.parentId)) {
            groups.set(node.parentId, {
              parent,
              children: [],
              bounds: new DOMRect(0, 0, 0, 0),
            });
          }
          groups.get(node.parentId)!.children.push(node);
        }
      }
    }

    // Calculate bounding boxes for each group
    const padding = 15;
    for (const group of groups.values()) {
      const allNodes = [group.parent, ...group.children];

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (const node of allNodes) {
        const left = node.x - node.width / 2;
        const top = node.y - node.height / 2;
        const right = node.x + node.width / 2;
        const bottom = node.y + node.height / 2;

        minX = Math.min(minX, left);
        minY = Math.min(minY, top);
        maxX = Math.max(maxX, right);
        maxY = Math.max(maxY, bottom);
      }

      group.bounds = new DOMRect(
        minX - padding,
        minY - padding,
        maxX - minX + padding * 2,
        maxY - minY + padding * 2,
      );
    }

    return groups;
  }

  private renderParentGroups(): TemplateResult[] {
    const groups = this.computeParentGroups();
    const results: TemplateResult[] = [];

    for (const group of groups.values()) {
      // Only render groups with at least one visible child
      if (group.children.length === 0) continue;

      const { bounds, parent } = group;
      const label = this.truncateLabel(parent.label, 12);

      results.push(svg`
        <g class="parent-group">
          <rect
            class="parent-group-rect"
            x="${bounds.x}"
            y="${bounds.y}"
            width="${bounds.width}"
            height="${bounds.height}"
          />
          <text
            class="parent-group-label"
            x="${bounds.x + 6}"
            y="${bounds.y + 12}"
          >
            ${label}
          </text>
        </g>
      `);
    }

    return results;
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

    const scaledWidth = this.svgWidth * this.zoomLevel;
    const scaledHeight = this.svgHeight * this.zoomLevel;

    return html`
      <svg
        class="graph-svg"
        width="${scaledWidth}"
        height="${scaledHeight}"
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

        <g class="parent-groups">
          ${this.renderParentGroups()}
        </g>

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
