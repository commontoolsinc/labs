import { css, html, LitElement } from "lit";
import { property, state } from "lit/decorators.js";
import { StorageInspectorState } from "../lib/storage-inspector.ts";
import { ResizableDrawerController } from "../lib/resizable-drawer-controller.ts";

/**
 * Network inspector view for monitoring storage operations in real-time.
 *
 * Provides a developer tool interface showing:
 * - Push/pull operations with transaction details
 * - Active subscriptions with update tracking
 * - Connection status and error states
 * - Filtering and JSON inspection capabilities
 *
 * Features a resizable drawer interface with keyboard shortcuts
 * and operation counters for tracking activity.
 */
export class XInspectorView extends LitElement {
  static override styles = css`
    :host {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 50;
    }

    .inspector-container {
      background-color: #111827; /* gray-900 */
      color: white;
      box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.5);
      border-top: 1px solid #374151; /* gray-700 */
      font-size: 0.75rem;
      display: flex;
      flex-direction: column;
      transition: transform 0.3s ease-in-out;
    }

    .inspector-container[hidden] {
      transform: translateY(100%);
    }

    .resize-handle {
      height: 1.5rem;
      width: 100%;
      cursor: ns-resize;
      display: flex;
      align-items: center;
      justify-content: center;
      border-bottom: 1px solid #374151; /* gray-700 */
      flex-shrink: 0;
    }

    .resize-grip {
      width: 4rem;
      height: 0.25rem;
      background-color: #4b5563; /* gray-600 */
      border-radius: 9999px;
    }

    .tabs-container {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.5rem 1rem;
      border-bottom: 1px solid #374151; /* gray-700 */
    }

    .tab-buttons {
      display: flex;
      gap: 0.5rem;
    }

    .tab-button {
      padding: 0.125rem 0.5rem;
      background: none;
      border: none;
      color: #9ca3af; /* gray-400 */
      cursor: pointer;
      border-radius: 0.25rem;
      font-size: 0.75rem;
    }

    .tab-button:hover {
      color: #d1d5db; /* gray-300 */
    }

    .tab-button.active {
      background-color: #374151; /* gray-700 */
      color: white;
    }

    .controls {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .clear-button {
      background-color: #374151; /* gray-700 */
      color: #9ca3af; /* gray-400 */
      border: none;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      font-size: 0.75rem;
      cursor: pointer;
      transition: all 0.2s;
    }

    .clear-button:hover {
      background-color: #4b5563; /* gray-600 */
      color: white;
    }

    .filter-container {
      position: relative;
    }

    .filter-input {
      width: 8rem;
      padding: 0.125rem 0.5rem;
      font-size: 0.75rem;
      background-color: #1f2937; /* gray-800 */
      border: 1px solid #374151; /* gray-700 */
      border-radius: 0.25rem;
      color: white;
      outline: none;
    }

    .filter-input:focus {
      border-color: #3b82f6; /* blue-500 */
    }

    .filter-input.has-value {
      border-color: #3b82f6; /* blue-500 */
    }

    .clear-filter {
      position: absolute;
      right: 0.25rem;
      top: 50%;
      transform: translateY(-50%);
      background: none;
      border: none;
      color: #9ca3af; /* gray-400 */
      cursor: pointer;
      padding: 0.125rem;
      line-height: 1;
    }

    .clear-filter:hover {
      color: white;
    }

    .connection-status {
      font-size: 0.75rem;
    }

    .connection-status.ready {
      color: #10b981; /* green-500 */
    }

    .connection-status.pending {
      color: #3b82f6; /* blue-500 */
    }

    .connection-status.error {
      color: #ef4444; /* red-500 */
    }

    .content-area {
      flex: 1;
      overflow: auto;
      padding: 0.5rem;
    }

    .content-area.resizing {
      pointer-events: none;
    }

    .empty-state {
      color: #6b7280; /* gray-500 */
      font-style: italic;
      text-align: center;
      padding: 0.25rem;
    }

    .actions-list {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .action-item {
      padding: 0.25rem;
      background-color: #1f2937; /* gray-800 */
      border-radius: 0.375rem;
      cursor: pointer;
    }

    .action-item:hover {
      background-color: #374151; /* gray-700 */
    }

    .action-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .action-info {
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }

    .action-icon {
      font-size: 0.875rem;
    }

    .action-icon.push {
      color: #3b82f6; /* blue-400 */
    }

    .action-icon.pull {
      color: #a855f7; /* purple-400 */
    }

    .action-icon.error {
      color: #ef4444; /* red-400 */
    }

    .action-content {
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
    }

    .action-id {
      font-family: monospace;
      font-size: 0.75rem;
    }

    .transaction-line {
      font-size: 0.7rem;
      color: #9ca3af; /* gray-400 */
    }

    .transaction-of {
      color: #fbbf24; /* yellow-300 */
    }

    .transaction-the {
      color: #34d399; /* green-300 */
    }

    .transaction-cause {
      color: #60a5fa; /* blue-300 */
    }

    .action-details {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .action-time {
      font-size: 0.75rem;
      opacity: 0.7;
    }

    .expand-icon {
      margin-left: 0.25rem;
    }

    .action-result {
      margin-top: 0.25rem;
      padding-left: 1rem;
      font-size: 0.75rem;
    }

    .action-result.error {
      color: #ef4444; /* red-400 */
    }

    .action-result.success {
      color: #10b981; /* green-400 */
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .action-expanded {
      margin-top: 0.25rem;
      position: relative;
      background-color: #111827; /* gray-900 */
      border-radius: 0.25rem;
    }

    .action-expanded pre {
      padding: 0.5rem;
      margin: 0;
      font-family: monospace;
      font-size: 0.6875rem;
      overflow: auto;
      max-height: 10rem;
    }

    .action-expanded.full-height pre {
      max-height: none;
    }

    .json-controls {
      position: absolute;
      top: 0.25rem;
      right: 0.25rem;
      display: flex;
      gap: 0.25rem;
    }

    .json-control-btn {
      background-color: #374151; /* gray-700 */
      color: white;
      border: none;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      font-size: 0.6875rem;
      cursor: pointer;
      opacity: 0.8;
      transition: opacity 0.2s;
    }

    .json-control-btn:hover {
      opacity: 1;
      background-color: #4b5563; /* gray-600 */
    }

    .subscriptions-table {
      width: 100%;
      overflow: auto;
    }

    .subscriptions-table table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.75rem;
    }

    .subscriptions-table th {
      text-align: left;
      padding: 0.25rem;
      border-bottom: 1px solid #374151; /* gray-700 */
    }

    .subscriptions-table td {
      padding: 0.25rem;
      border-bottom: 1px solid #374151; /* gray-700 */
    }

    .subscriptions-table tr:hover {
      background-color: #1f2937; /* gray-800 */
    }

    .sub-id {
      font-family: monospace;
      max-width: 8rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .sub-cmd {
      max-width: 10rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .sub-age {
      white-space: nowrap;
    }

    .sub-updated {
      color: #9ca3af; /* gray-400 */
    }

    .sub-expand-btn {
      background: none;
      border: none;
      color: #3b82f6; /* blue-400 */
      cursor: pointer;
      padding: 0.125rem;
    }

    .sub-expanded {
      padding: 0.5rem;
      background-color: #1f2937; /* gray-800 */
    }

    .sub-expanded pre {
      margin: 0;
      font-family: monospace;
      font-size: 0.6875rem;
      overflow: auto;
      max-height: 10rem;
    }
  `;

  @property({ type: Boolean })
  visible = false;

  @property({ attribute: false })
  inspectorState?: StorageInspectorState;

  @property({ type: Number })
  updateVersion = 0;

  @state()
  private activeTab: "actions" | "subscriptions" = "actions";

  @state()
  private filterText = "";

  @state()
  private expandedRows = new Set<string>();

  @state()
  private fullHeightJsonRows = new Set<string>();

  private resizeController = new ResizableDrawerController(this, {
    initialHeight: 240,
    minHeight: 150,
    maxHeightFactor: 0.8,
    resizeDirection: "up",
    storageKey: "inspectorDrawerHeight",
  });

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this.handleKeyDown);
  }

  override disconnectedCallback() {
    document.removeEventListener("keydown", this.handleKeyDown);
    super.disconnectedCallback();
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    // Clear filter on Escape
    if (e.key === "Escape" && this.filterText) {
      e.preventDefault();
      this.filterText = "";
    }
  };

  private handleToggle() {
    this.dispatchEvent(
      new CustomEvent("toggle-inspector", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleClearHistory = () => {
    if (this.inspectorState) {
      this.inspectorState.clearAll();
      // Clear expanded rows since they may no longer exist
      this.expandedRows.clear();
      this.fullHeightJsonRows.clear();
      // Force update to refresh display
      this.requestUpdate();
    }
  };

  private getConnectionStatus() {
    if (!this.inspectorState) return "";

    const { connection } = this.inspectorState;
    if (connection.pending) {
      if (connection.pending.ok) {
        return html`
          <span class="connection-status pending">
            Conn: A${connection.pending.ok.attempt}
          </span>
        `;
      } else {
        return html`
          <span class="connection-status error">
            Err: ${connection.pending.error?.message}
          </span>
        `;
      }
    }
    return html`
      <span class="connection-status ready">
        Conn: A${connection.ready?.ok?.attempt}
      </span>
    `;
  }

  private renderActions() {
    if (!this.inspectorState) {
      return html`
        <div class="empty-state">No actions</div>
      `;
    }

    // Use getAllPush/getAllPull to include history
    const allPush = this.inspectorState.getAllPush();
    const allPull = this.inspectorState.getAllPull();

    // Combine push and pull items
    const pushItems = Object.entries(allPush).map(([id, result]) => ({
      id,
      type: "push" as const,
      result,
      time: result.error?.time ||
        this.inspectorState!.getOperationTime(id) ||
        this.inspectorState!.connection.time,
      hasError: !!result.error,
      details: this.extractTransactionDetails(result),
    }));

    const pullItems = Object.entries(allPull).map(([id, result]) => ({
      id,
      type: "pull" as const,
      result,
      time: result.error?.time ||
        this.inspectorState!.getOperationTime(id) ||
        this.inspectorState!.connection.time,
      hasError: !!result.error,
      details: null, // pulls don't have of/the/cause
    }));

    let items = [...pushItems, ...pullItems].sort((a, b) => b.time - a.time);

    // Apply filter if present
    if (this.filterText) {
      try {
        const regex = new RegExp(this.filterText, "i");
        items = items.filter((item) =>
          regex.test(item.id) ||
          regex.test(item.type) ||
          regex.test(JSON.stringify(item.result))
        );
      } catch (e) {
        // Fallback to simple string search if regex is invalid
        const filter = this.filterText.toLowerCase();
        items = items.filter((item) => {
          const itemStr = JSON.stringify(item).toLowerCase();
          return itemStr.includes(filter);
        });
      }
    }

    if (items.length === 0) {
      return html`
        <div class="empty-state">
          No actions ${this.filterText ? "matching filter" : ""}
        </div>
      `;
    }

    return html`
      <div class="actions-list">
        ${items.map((item) => this.renderActionItem(item))}
      </div>
    `;
  }

  private renderSubscriptions() {
    if (!this.inspectorState) {
      return html`
        <div class="empty-state">No subscriptions</div>
      `;
    }

    let subscriptions = Object.entries(this.inspectorState.subscriptions);

    // Apply filter if present
    if (this.filterText) {
      try {
        const regex = new RegExp(this.filterText, "i");
        subscriptions = subscriptions.filter(([id, sub]) =>
          regex.test(id) ||
          regex.test(sub.source.cmd) ||
          regex.test(JSON.stringify(sub))
        );
      } catch (e) {
        // Fallback to simple string search if regex is invalid
        const filter = this.filterText.toLowerCase();
        subscriptions = subscriptions.filter(([id, sub]) => {
          const subStr = JSON.stringify({ id, ...sub }).toLowerCase();
          return subStr.includes(filter);
        });
      }
    }

    if (subscriptions.length === 0) {
      return html`
        <div class="empty-state">
          No subscriptions ${this.filterText ? "matching filter" : ""}
        </div>
      `;
    }

    return html`
      <div class="subscriptions-table">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Command</th>
              <th>Age</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${subscriptions.map(([id, sub]) =>
        this.renderSubscriptionRow(id, sub)
      )}
          </tbody>
        </table>
      </div>
    `;
  }

  override render() {
    const containerStyle = `height: ${this.resizeController.drawerHeight}px`;

    return html`
      ${this.visible
        ? html`
          <div class="inspector-container" style="${containerStyle}">
            <div
              class="resize-handle"
              @mousedown="${this.resizeController.handleResizeStart}"
              @touchstart="${this.resizeController.handleTouchResizeStart}"
            >
              <div class="resize-grip"></div>
            </div>

            <div class="tabs-container">
              <div class="tab-buttons">
                <button
                  type="button"
                  class="tab-button ${this.activeTab === "actions"
            ? "active"
            : ""}"
                  @click="${() => this.activeTab = "actions"}"
                >
                  Actions (${this.getActionCount()})
                </button>
                <button
                  type="button"
                  class="tab-button ${this.activeTab === "subscriptions"
            ? "active"
            : ""}"
                  @click="${() => this.activeTab = "subscriptions"}"
                >
                  Subscriptions (${this.getSubscriptionCount()})
                </button>
              </div>

              <div class="controls">
                <div class="filter-container">
                  <input
                    type="text"
                    placeholder="Filter..."
                    class="filter-input ${this.filterText ? "has-value" : ""}"
                    .value="${this.filterText}"
                    @input="${(e: Event) =>
            this.filterText = (e.target as HTMLInputElement).value}"
                  />
                  ${this.filterText
            ? html`
              <button
                type="button"
                class="clear-filter"
                @click="${() => this.filterText = ""}"
              >
                ×
              </button>
            `
            : ""}
                </div>
                <div>${this.getConnectionStatus()}</div>
                <button
                  type="button"
                  class="clear-button"
                  @click="${this.handleClearHistory}"
                  title="Clear history"
                >
                  Clear
                </button>
              </div>
            </div>

            <div class="content-area ${this.resizeController.isResizing
            ? "resizing"
            : ""}">
              ${this.activeTab === "actions"
            ? this.renderActions()
            : this.renderSubscriptions()}
            </div>
          </div>
        `
        : ""}
    `;
  }

  private getActionCount(): number {
    if (!this.inspectorState) return 0;
    return Object.keys(this.inspectorState.getAllPush()).length +
      Object.keys(this.inspectorState.getAllPull()).length;
  }

  private getSubscriptionCount(): number {
    if (!this.inspectorState) return 0;
    return Object.keys(this.inspectorState.subscriptions).length;
  }

  private toggleRowExpand(id: string) {
    const newSet = new Set(this.expandedRows);
    if (newSet.has(id)) {
      newSet.delete(id);
      // Also remove from full height when collapsing
      const fullHeightSet = new Set(this.fullHeightJsonRows);
      fullHeightSet.delete(id);
      this.fullHeightJsonRows = fullHeightSet;
    } else {
      newSet.add(id);
    }
    this.expandedRows = newSet;
  }

  private toggleJsonFullHeight(id: string) {
    const newSet = new Set(this.fullHeightJsonRows);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    this.fullHeightJsonRows = newSet;
  }

  private async copyJson(data: any) {
    try {
      const jsonString = JSON.stringify(data, null, 2);
      await navigator.clipboard.writeText(jsonString);
      // Could add a toast notification here if desired
    } catch (err) {
      console.error("Failed to copy JSON:", err);
    }
  }

  private formatTime(time: number): string {
    const date = new Date(time);
    return `${date.toLocaleTimeString()}.${
      date.getMilliseconds().toString().padStart(3, "0")
    }`;
  }

  private getActionIcon(type: string, hasError: boolean): string {
    if (hasError) return "⁈";
    return type === "push" ? "↑" : "↓";
  }

  private extractTransactionDetails(
    result: any,
  ): { of: string; the: string; cause: string } | null {
    try {
      if (
        result.ok?.invocation?.cmd === "/memory/transact" &&
        result.ok?.invocation?.args?.changes
      ) {
        const changes = result.ok.invocation.args.changes;
        // Extract of, the, cause
        const ofs = Object.keys(changes);
        if (ofs.length > 0) {
          const of = ofs[0];
          const thes = Object.keys(changes[of]);
          if (thes.length > 0) {
            const the = thes[0];
            const causes = Object.keys(changes[of][the]);
            if (causes.length > 0) {
              const cause = causes[0];
              return { of, the, cause };
            }
          }
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  private renderActionItem(item: {
    id: string;
    type: "push" | "pull";
    result: any;
    time: number;
    hasError: boolean;
    details: { of: string; the: string; cause: string } | null;
  }) {
    const isExpanded = this.expandedRows.has(item.id);

    return html`
      <div class="action-item" @click="${() => this.toggleRowExpand(item.id)}">
        <div class="action-header">
          <div class="action-info">
            <span class="action-icon ${item.type} ${item.hasError
        ? "error"
        : ""}">
              ${this.getActionIcon(item.type, item.hasError)}
            </span>
            <div class="action-content">
              <div class="action-id">${item.id}</div>
              ${item.details
        ? html`
          <div class="transaction-line">
            of: <span class="transaction-of">${item.details.of}</span>
          </div>
          <div class="transaction-line">
            the: <span class="transaction-the">${item.details.the}</span>
          </div>
          <div class="transaction-line">
            cause: <span class="transaction-cause">${item.details.cause}</span>
          </div>
        `
        : ""}
            </div>
          </div>
          <div class="action-details">
            <span class="action-time">${this.formatTime(item.time)}</span>
            <span class="expand-icon">${isExpanded ? "▼" : "▶"}</span>
          </div>
        </div>

        ${item.hasError
        ? html`
          <div class="action-result error">
            ${item.result.error.message} ${item.result.error.reason
            ? html`
              <span style="opacity: 0.7; margin-left: 0.25rem;">
                (${item.result.error.reason})
              </span>
            `
            : ""}
          </div>
        `
        : ""} ${isExpanded
        ? html`
          <div class="action-expanded ${this.fullHeightJsonRows.has(item.id)
            ? "full-height"
            : ""}">
            <div class="json-controls">
              <button
                type="button"
                class="json-control-btn"
                @click="${(e: Event) => {
            e.stopPropagation();
            this.toggleJsonFullHeight(item.id);
          }}"
              >
                ${this.fullHeightJsonRows.has(item.id) ? "Collapse" : "Expand"}
              </button>
              <button
                type="button"
                class="json-control-btn"
                @click="${(e: Event) => {
            e.stopPropagation();
            this.copyJson(item.result);
          }}"
              >
                Copy
              </button>
            </div>
            <pre>${JSON.stringify(item.result, null, 2)}</pre>
          </div>
        `
        : ""}
      </div>
    `;
  }

  private renderSubscriptionRow(id: string, sub: any) {
    const isExpanded = this.expandedRows.has(id);
    const now = Date.now();
    const ageSeconds = Math.floor((now - sub.opened) / 1000);
    const updateSeconds = sub.updated
      ? Math.floor((now - sub.updated) / 1000)
      : null;

    return html`
      <tr>
        <td class="sub-id">${id}</td>
        <td class="sub-cmd">${sub.source.cmd}</td>
        <td class="sub-age">
          ${ageSeconds}s ${updateSeconds !== null
        ? html`
          <span class="sub-updated">
            (+${updateSeconds}s)
          </span>
        `
        : ""}
        </td>
        <td>
          <button
            type="button"
            class="sub-expand-btn"
            @click="${(e: Event) => {
        e.stopPropagation();
        this.toggleRowExpand(id);
      }}"
          >
            ${isExpanded ? "▼" : "▶"}
          </button>
        </td>
      </tr>
      ${isExpanded
        ? html`
          <tr>
            <td colspan="4" class="sub-expanded">
              <pre>${JSON.stringify(sub, null, 2)}</pre>
            </td>
          </tr>
        `
        : ""}
    `;
  }
}

globalThis.customElements.define("x-inspector-view", XInspectorView);
