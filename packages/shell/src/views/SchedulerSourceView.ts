import { css, html, LitElement, TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import type { PatternSourceInfo } from "@commontools/runtime-client";

/** Parsed source location from an action ID */
interface ActionLocation {
  file: string;
  line: number;
  col: number;
}

/** Aggregated info for all actions on a single source line */
interface LineAnnotation {
  nodeIds: string[];
  types: Set<string>; // "effect" | "computation"
  totalTime: number; // sum of all actions' totalTime on this line
  runCount: number; // sum of all actions' runCount on this line
}

/** Minimal node info passed from parent */
export interface SourceViewNode {
  id: string;
  type: string;
  label: string;
  stats?: { totalTime: number; runCount: number };
  patternId?: string;
}

/**
 * Parse an action ID into a source location.
 * IDs look like "/main.tsx:42:15" or "/main.tsx:42:15 [via ...]"
 */
export function parseActionLocation(
  actionId: string,
): ActionLocation | null {
  const clean = actionId.replace(/\s*\[via.*\]$/, "");
  const match = clean.match(/^(.+):(\d+):(\d+)$/);
  if (!match) return null;
  return {
    file: match[1],
    line: parseInt(match[2], 10),
    col: parseInt(match[3], 10),
  };
}

/**
 * Source code browser for the scheduler debugger.
 * Shows pattern source with action lines highlighted as a heat map.
 */
export class XSchedulerSource extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    .source-toolbar {
      display: flex;
      gap: 0.5rem;
      padding: 0.5rem 1rem;
      background: #1e293b;
      border-bottom: 1px solid #334155;
      align-items: center;
      flex-shrink: 0;
    }

    .source-toolbar select {
      background: #334155;
      border: 1px solid #475569;
      color: #e2e8f0;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      font-size: 0.75rem;
      font-family: monospace;
    }

    .source-toolbar label {
      color: #94a3b8;
      font-size: 0.75rem;
      font-family: monospace;
    }

    .file-tabs {
      display: flex;
      gap: 0;
      overflow-x: auto;
    }

    .file-tab {
      padding: 0.25rem 0.75rem;
      background: #334155;
      border: 1px solid #475569;
      border-bottom: none;
      color: #94a3b8;
      font-size: 0.7rem;
      font-family: monospace;
      cursor: pointer;
      white-space: nowrap;
    }

    .file-tab:first-child {
      border-radius: 0.25rem 0 0 0;
    }

    .file-tab:last-child {
      border-radius: 0 0.25rem 0 0;
    }

    .file-tab:not(:first-child) {
      border-left: none;
    }

    .file-tab:hover {
      background: #475569;
      color: white;
    }

    .file-tab.active {
      background: #1e293b;
      color: #e2e8f0;
      border-bottom-color: #1e293b;
    }

    .source-container {
      flex: 1;
      overflow: auto;
      background: #0f172a;
      font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
      font-size: 12px;
      line-height: 1.5;
    }

    .source-table {
      border-collapse: collapse;
      width: 100%;
    }

    .source-line {
      cursor: default;
      transition: background-color 0.15s;
    }

    .source-line:hover {
      filter: brightness(1.2);
    }

    .source-line.has-action {
      cursor: pointer;
    }

    .source-line.selected {
      outline: 1px solid #60a5fa;
      outline-offset: -1px;
    }

    .line-gutter {
      padding: 0 0.5rem 0 0.75rem;
      text-align: right;
      color: #475569;
      user-select: none;
      white-space: nowrap;
      vertical-align: top;
      width: 1px;
    }

    .line-markers {
      padding: 0 0.25rem;
      width: 1px;
      vertical-align: top;
    }

    .marker-dot {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      margin: 0 1px;
      vertical-align: middle;
    }

    .marker-dot.effect {
      background: #3b82f6;
    }

    .marker-dot.computation {
      background: #a78bfa;
    }

    .line-code {
      padding: 0 1rem 0 0.5rem;
      white-space: pre;
      color: #e2e8f0;
    }

    .line-stats {
      padding: 0 0.75rem 0 0.5rem;
      text-align: right;
      color: #94a3b8;
      font-size: 0.65rem;
      white-space: nowrap;
      vertical-align: top;
      width: 1px;
    }

    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #64748b;
      font-family: monospace;
      font-size: 0.85rem;
    }
  `;

  @property({ attribute: false })
  patternSources: PatternSourceInfo[] = [];

  @property({ attribute: false })
  nodes: Map<string, SourceViewNode> = new Map();

  @property({ attribute: false })
  selectedNodeId: string | null = null;

  @state()
  private selectedPatternIdx = 0;

  @state()
  private selectedFileIdx = 0;

  /** Build lookup: file -> line -> LineAnnotation */
  private buildAnnotations(): Map<string, Map<number, LineAnnotation>> {
    const result = new Map<string, Map<number, LineAnnotation>>();

    for (const [nodeId, node] of this.nodes) {
      const loc = parseActionLocation(nodeId);
      if (!loc) continue;

      // Only include nodes belonging to the current pattern
      const currentPattern = this.patternSources[this.selectedPatternIdx];
      if (
        currentPattern && node.patternId &&
        node.patternId !== currentPattern.patternId
      ) {
        continue;
      }

      let fileMap = result.get(loc.file);
      if (!fileMap) {
        fileMap = new Map();
        result.set(loc.file, fileMap);
      }

      let annotation = fileMap.get(loc.line);
      if (!annotation) {
        annotation = {
          nodeIds: [],
          types: new Set(),
          totalTime: 0,
          runCount: 0,
        };
        fileMap.set(loc.line, annotation);
      }

      annotation.nodeIds.push(nodeId);
      annotation.types.add(node.type);
      annotation.totalTime += node.stats?.totalTime ?? 0;
      annotation.runCount += node.stats?.runCount ?? 0;
    }

    return result;
  }

  /** Compute heat color based on totalTime relative to max */
  private heatColor(
    totalTime: number,
    maxTime: number,
    types: Set<string>,
  ): string {
    if (maxTime === 0) return "transparent";
    // Use sqrt for better visual distribution
    const intensity = Math.sqrt(totalTime / maxTime);
    const alpha = 0.08 + intensity * 0.35;
    // Blue for effects, violet for computations, blend if both
    if (types.has("effect") && types.has("computation")) {
      return `rgba(99, 140, 255, ${alpha})`;
    } else if (types.has("computation")) {
      return `rgba(167, 139, 250, ${alpha})`;
    }
    return `rgba(59, 130, 246, ${alpha})`;
  }

  private formatTime(ms: number): string {
    if (ms === 0) return "";
    if (ms < 1) return `${(ms * 1000).toFixed(0)}us`;
    if (ms < 1000) return `${ms.toFixed(1)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }

  private handleLineClick(nodeIds: string[]) {
    if (nodeIds.length === 0) return;
    // Select the first node; user can cycle through via detail pane
    this.dispatchEvent(
      new CustomEvent("node-selected", {
        detail: { nodeId: nodeIds[0], allNodeIds: nodeIds },
        bubbles: true,
        composed: true,
      }),
    );
  }

  override updated(changedProperties: Map<string, unknown>) {
    super.updated(changedProperties);
    // Auto-scroll to selected node
    if (changedProperties.has("selectedNodeId") && this.selectedNodeId) {
      const loc = parseActionLocation(this.selectedNodeId);
      if (loc) {
        const row = this.shadowRoot?.querySelector(
          `.source-line[data-line="${loc.line}"]`,
        );
        row?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }

  override render(): TemplateResult {
    if (this.patternSources.length === 0) {
      return html`
        <div class="empty-state">
          No pattern sources available. Click Refresh to load.
        </div>
      `;
    }

    // Clamp indices
    const patternIdx = Math.min(
      this.selectedPatternIdx,
      this.patternSources.length - 1,
    );
    const pattern = this.patternSources[patternIdx];
    if (!pattern || pattern.files.length === 0) {
      return html`
        <div class="empty-state">Pattern has no source files.</div>
      `;
    }

    const fileIdx = Math.min(this.selectedFileIdx, pattern.files.length - 1);
    const file = pattern.files[fileIdx];
    const lines = file.contents.split("\n");

    // Build annotations for current file
    const annotations = this.buildAnnotations();
    const fileAnnotations = annotations.get(file.name) ?? new Map();

    // Find max totalTime across all annotations for heat scaling
    let maxTime = 0;
    for (const ann of fileAnnotations.values()) {
      if (ann.totalTime > maxTime) maxTime = ann.totalTime;
    }

    // Find which line the selected node is on
    const selectedLoc = this.selectedNodeId
      ? parseActionLocation(this.selectedNodeId)
      : null;

    return html`
      <div class="source-toolbar">
        ${this.patternSources.length > 1
          ? html`
            <label>Pattern:</label>
            <select
              @change="${(e: Event) => {
                this.selectedPatternIdx =
                  (e.target as HTMLSelectElement).selectedIndex;
                this.selectedFileIdx = 0;
              }}"
            >
              ${this.patternSources.map(
                (p, i) =>
                  html`
                    <option ?selected="${i === patternIdx}">
                      ${p.patternName || p.patternId.slice(0, 12)}
                    </option>
                  `,
              )}
            </select>
          `
          : html`
            <label>
              ${pattern.patternName || pattern.patternId.slice(0, 12)}
            </label>
          `} ${pattern.files.length > 1
          ? html`
            <div class="file-tabs">
              ${pattern.files.map(
                (f, i) =>
                  html`
                    <button
                      type="button"
                      class="file-tab ${i === fileIdx ? "active" : ""}"
                      @click="${() => (this.selectedFileIdx = i)}"
                    >
                      ${f.name}
                    </button>
                  `,
              )}
            </div>
          `
          : html`
            <label>${file.name}</label>
          `}
      </div>

      <div class="source-container">
        <table class="source-table">
          <tbody>
            ${lines.map((lineText, i) => {
              const lineNum = i + 1;
              const ann = fileAnnotations.get(lineNum);
              const hasAction = !!ann;
              const isSelected = selectedLoc?.file === file.name &&
                selectedLoc?.line === lineNum;
              const bgColor = ann
                ? this.heatColor(ann.totalTime, maxTime, ann.types)
                : "transparent";

              return html`
                <tr
                  class="source-line ${hasAction
                    ? "has-action"
                    : ""} ${isSelected ? "selected" : ""}"
                  data-line="${lineNum}"
                  style="background-color: ${bgColor}"
                  @click="${hasAction
                    ? () => this.handleLineClick(ann!.nodeIds)
                    : undefined}"
                >
                  <td class="line-gutter">${lineNum}</td>
                  <td class="line-markers">
                    ${ann
                      ? Array.from(ann.types).map(
                        (t) =>
                          html`
                            <span class="marker-dot ${t}"></span>
                          `,
                      )
                      : ""}
                  </td>
                  <td class="line-code">${lineText}</td>
                  <td class="line-stats">
                    ${ann
                      ? html`
                        ${this.formatTime(ann.totalTime)} ${ann.runCount > 0
                          ? `(${ann.runCount}x)`
                          : ""}
                      `
                      : ""}
                  </td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      </div>
    `;
  }
}

customElements.define("x-scheduler-source", XSchedulerSource);
