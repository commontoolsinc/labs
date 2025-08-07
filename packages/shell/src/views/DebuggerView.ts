import { css, html, LitElement } from "lit";
import { property, state } from "lit/decorators.js";
import { ResizableDrawerController } from "../lib/resizable-drawer-controller.ts";
import type { RuntimeTelemetryMarkerResult } from "@commontools/runner";

/**
 * Hierarchical topic definitions for filtering telemetry events.
 * Topics can have subtopics for more granular filtering.
 */
export const TOPIC_HIERARCHY = {
  scheduler: {
    label: "Scheduler",
    icon: "⚙️",
    color: "#3b82f6", // blue
    subtopics: {
      run: { label: "Run", pattern: "scheduler.run" },
      invocation: { label: "Invocation", pattern: "scheduler.invocation" },
    },
  },
  storage: {
    label: "Storage",
    icon: "💾",
    color: "#10b981", // green
    subtopics: {
      push: { label: "Push", pattern: "storage.push" },
      pull: { label: "Pull", pattern: "storage.pull" },
      connection: { label: "Connection", pattern: "storage.connection" },
      subscription: { label: "Subscriptions", pattern: "storage.subscription" },
    },
  },
  cells: {
    label: "Cells",
    icon: "📝",
    color: "#8b5cf6", // violet
    subtopics: {
      update: { label: "Update", pattern: "cell.update" },
    },
  },
} as const;

export type TopicKey = keyof typeof TOPIC_HIERARCHY;
export type SubtopicKey<T extends TopicKey> =
  keyof typeof TOPIC_HIERARCHY[T]["subtopics"];

/**
 * Shell Debugger view for monitoring RuntimeTelemetry events in real-time.
 *
 * Provides a developer tool interface showing:
 * - All telemetry events with timestamps and details
 * - Topic-based filtering for focused debugging
 * - Search functionality for event content
 * - Event expansion for detailed inspection
 * - Performance metrics and statistics
 *
 * Features a resizable drawer interface similar to the Inspector
 * but focused on telemetry events rather than storage operations.
 */
export class XDebuggerView extends LitElement {
  static override styles = css`
    :host {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 50;
    }

    .debugger-container {
      background-color: #0f172a; /* slate-900 */
      color: white;
      box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.5);
      border-top: 1px solid #334155; /* slate-700 */
      font-size: 0.75rem;
      display: flex;
      flex-direction: column;
      transition: transform 0.3s ease-in-out;
    }

    .debugger-container[hidden] {
      transform: translateY(100%);
    }

    .resize-handle {
      height: 1.5rem;
      width: 100%;
      cursor: ns-resize;
      display: flex;
      align-items: center;
      justify-content: center;
      border-bottom: 1px solid #334155; /* slate-700 */
      flex-shrink: 0;
    }

    .resize-grip {
      width: 4rem;
      height: 0.25rem;
      background-color: #475569; /* slate-600 */
      border-radius: 9999px;
    }

    .header-container {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.5rem 1rem;
      border-bottom: 1px solid #334155; /* slate-700 */
      background-color: #1e293b; /* slate-800 */
    }

    .title {
      font-weight: 600;
      font-size: 0.875rem;
      color: #cbd5e1; /* slate-300 */
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .title-icon {
      font-size: 1rem;
    }

    .stats {
      display: flex;
      gap: 1rem;
      font-size: 0.6875rem;
      color: #94a3b8; /* slate-400 */
    }

    .stat {
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }

    .stat-label {
      opacity: 0.7;
    }

    .stat-value {
      font-family: monospace;
      color: #cbd5e1; /* slate-300 */
    }

    .toolbar-container {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.5rem 1rem;
      border-bottom: 1px solid #334155; /* slate-700 */
      gap: 1rem;
    }

    .topics-filter {
      display: flex;
      gap: 0.25rem;
      flex-wrap: wrap;
    }

    .topic-button-group {
      position: relative;
      display: inline-flex;
    }

    .topic-toggle {
      padding: 0.25rem 0.5rem;
      background-color: #1e293b; /* slate-800 */
      border: 1px solid #334155; /* slate-700 */
      border-radius: 0.375rem 0 0 0.375rem;
      font-size: 0.6875rem;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 0.25rem;
      color: #64748b; /* slate-500 */
    }

    .topic-toggle:hover {
      background-color: #334155; /* slate-700 */
    }

    .topic-toggle.active {
      background-color: var(--topic-color);
      border-color: var(--topic-color);
      color: white;
      opacity: 0.9;
    }

    .topic-toggle.partial {
      background-color: var(--topic-color);
      background-image: repeating-linear-gradient(
        45deg,
        transparent,
        transparent 2px,
        rgba(0, 0, 0, 0.15) 2px,
        rgba(0, 0, 0, 0.15) 4px
      );
      border-color: var(--topic-color);
      color: white;
      opacity: 0.9;
    }

    .dropdown-trigger {
      padding: 0.25rem 0.375rem;
      background-color: #334155; /* Default gray background */
      border: 1px solid #334155; /* slate-700 */
      border-left: none;
      border-radius: 0 0.375rem 0.375rem 0;
      font-size: 0.5rem;
      cursor: pointer;
      transition: all 0.2s;
      color: #94a3b8; /* slate-400 */
    }

    .dropdown-trigger:hover {
      background-color: #475569; /* slate-600 on hover */
    }

    .topic-toggle.active + .dropdown-trigger,
    .topic-toggle.partial + .dropdown-trigger {
      border-color: var(--topic-color);
      background-color: var(--topic-color);
      filter: brightness(0.8); /* Slightly darker than main button */
      color: white;
    }

    .subtopic-dropdown {
      position: absolute;
      top: 100%;
      left: 0;
      margin-top: 0.25rem;
      background-color: #1e293b; /* slate-800 */
      border: 1px solid #334155; /* slate-700 */
      border-radius: 0.375rem;
      padding: 0.5rem;
      min-width: 10rem;
      z-index: 100;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
    }

    .subtopic-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.25rem;
      font-size: 0.6875rem;
      color: #cbd5e1; /* slate-300 */
      cursor: pointer;
      border-radius: 0.25rem;
    }

    .subtopic-item:hover {
      background-color: #334155; /* slate-700 */
    }

    .subtopic-checkbox {
      width: 0.875rem;
      height: 0.875rem;
      accent-color: var(--topic-color);
    }

    .topic-icon {
      font-size: 0.75rem;
    }

    .controls {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .search-container {
      position: relative;
    }

    .search-input {
      width: 12rem;
      padding: 0.25rem 0.5rem;
      font-size: 0.6875rem;
      background-color: #1e293b; /* slate-800 */
      border: 1px solid #334155; /* slate-700 */
      border-radius: 0.375rem;
      color: white;
      outline: none;
    }

    .search-input:focus {
      border-color: #3b82f6; /* blue-500 */
    }

    .search-input.has-value {
      border-color: #3b82f6; /* blue-500 */
    }

    .clear-search {
      position: absolute;
      right: 0.25rem;
      top: 50%;
      transform: translateY(-50%);
      background: none;
      border: none;
      color: #94a3b8; /* slate-400 */
      cursor: pointer;
      padding: 0.125rem;
      line-height: 1;
    }

    .clear-search:hover {
      color: white;
    }

    .action-button {
      background-color: #334155; /* slate-700 */
      color: #94a3b8; /* slate-400 */
      border: none;
      padding: 0.25rem 0.5rem;
      border-radius: 0.375rem;
      font-size: 0.6875rem;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }

    .action-button:hover {
      background-color: #475569; /* slate-600 */
      color: white;
    }

    .content-area {
      flex: 1;
      overflow: auto;
      padding: 0.5rem;
      font-family: monospace;
    }

    .content-area.resizing {
      pointer-events: none;
    }

    .empty-state {
      color: #64748b; /* slate-500 */
      font-style: italic;
      text-align: center;
      padding: 2rem;
      font-size: 0.875rem;
    }

    .events-list {
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
    }

    .event-item {
      padding: 0.375rem 0.5rem;
      background-color: #1e293b; /* slate-800 */
      border-radius: 0.375rem;
      border: 1px solid #334155; /* slate-700 */
      transition: all 0.2s;
      cursor: pointer;
    }

    .event-item:hover {
      background-color: #334155; /* slate-700 */
      border-color: #475569; /* slate-600 */
    }

    .event-item.expanded {
      background-color: #334155; /* slate-700 */
    }

    .event-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 0.5rem;
    }

    .event-main {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      flex: 1;
    }

    .event-icon {
      font-size: 0.875rem;
      margin-top: 0.125rem;
    }

    .event-content {
      flex: 1;
      min-width: 0;
    }

    .event-type {
      font-weight: 600;
      font-size: 0.75rem;
      color: #e2e8f0; /* slate-200 */
      margin-bottom: 0.125rem;
    }

    .event-details {
      font-size: 0.6875rem;
      color: #94a3b8; /* slate-400 */
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .event-detail {
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }

    .event-detail-label {
      opacity: 0.7;
    }

    .event-detail-value {
      color: #cbd5e1; /* slate-300 */
      font-family: monospace;
    }

    .event-time {
      font-size: 0.6875rem;
      color: #64748b; /* slate-500 */
      white-space: nowrap;
    }

    .event-expanded {
      margin-top: 0.5rem;
      padding: 0.5rem;
      background-color: #0f172a; /* slate-900 */
      border-radius: 0.25rem;
      position: relative;
    }

    .event-expanded pre {
      margin: 0;
      font-size: 0.6875rem;
      color: #cbd5e1; /* slate-300 */
      overflow: auto;
      max-height: 12rem;
    }

    .event-expanded.full-height pre {
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
      background-color: #334155; /* slate-700 */
      color: white;
      border: none;
      padding: 0.125rem 0.375rem;
      border-radius: 0.25rem;
      font-size: 0.625rem;
      cursor: pointer;
      opacity: 0.8;
      transition: opacity 0.2s;
    }

    .json-control-btn:hover {
      opacity: 1;
      background-color: #475569; /* slate-600 */
    }

    .paused-indicator {
      background-color: #dc2626; /* red-600 */
      color: white;
      padding: 0.125rem 0.5rem;
      border-radius: 0.25rem;
      font-size: 0.6875rem;
      font-weight: 600;
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% {
        opacity: 1;
      }
      50% {
        opacity: 0.7;
      }
    }
  `;

  @property({ type: Boolean })
  visible = false;

  @property({ attribute: false })
  telemetryMarkers: RuntimeTelemetryMarkerResult[] = [];

  @state()
  private activeSubtopics = new Set<string>();

  @state()
  private openDropdowns = new Set<TopicKey>();

  @state()
  private searchText = "";

  @state()
  private expandedEvents = new Set<number>();

  @state()
  private fullHeightEvents = new Set<number>();

  @state()
  private isPaused = false;

  @state()
  private pausedMarkers: RuntimeTelemetryMarkerResult[] = [];

  private resizeController = new ResizableDrawerController(this, {
    initialHeight: 300,
    minHeight: 150,
    maxHeightFactor: 0.8,
    resizeDirection: "up",
    storageKey: "debuggerDrawerHeight",
  });

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this.handleKeyDown);
    document.addEventListener("click", this.handleDocumentClick);
    // Initialize with all subtopics active
    this.initializeAllSubtopics();
  }

  override disconnectedCallback() {
    document.removeEventListener("keydown", this.handleKeyDown);
    document.removeEventListener("click", this.handleDocumentClick);
    super.disconnectedCallback();
  }

  override updated(changedProperties: Map<string, unknown>) {
    super.updated(changedProperties);

    // When new markers come in and we're not paused, update the paused markers
    if (changedProperties.has("telemetryMarkers") && !this.isPaused) {
      this.pausedMarkers = [...this.telemetryMarkers];
    }
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    // Clear search on Escape
    if (e.key === "Escape" && this.searchText) {
      e.preventDefault();
      this.searchText = "";
    }
    // Toggle pause on Space when debugger is visible
    if (e.key === " " && this.visible && e.target === document.body) {
      e.preventDefault();
      this.togglePause();
    }
  };

  private initializeAllSubtopics() {
    const allSubtopics = new Set<string>();
    for (const [topicKey, topic] of Object.entries(TOPIC_HIERARCHY)) {
      for (const subtopicKey of Object.keys(topic.subtopics)) {
        allSubtopics.add(`${topicKey}.${subtopicKey}`);
      }
    }
    this.activeSubtopics = allSubtopics;
  }

  private handleDocumentClick = (e: Event) => {
    // Close dropdowns when clicking outside
    const target = e.target as HTMLElement;
    if (!target.closest(".topic-button-group")) {
      this.openDropdowns = new Set();
    }
  };

  private toggleDropdown(topicKey: TopicKey, e: Event) {
    e.stopPropagation();
    const newDropdowns = new Set(this.openDropdowns);
    if (newDropdowns.has(topicKey)) {
      newDropdowns.delete(topicKey);
    } else {
      // Close other dropdowns
      newDropdowns.clear();
      newDropdowns.add(topicKey);
    }
    this.openDropdowns = newDropdowns;
  }

  private toggleTopic(topicKey: TopicKey) {
    const topic = TOPIC_HIERARCHY[topicKey];
    const subtopicKeys = Object.keys(topic.subtopics);
    const fullKeys = subtopicKeys.map((sk) => `${topicKey}.${sk}`);

    // Check current state
    const activeCount =
      fullKeys.filter((k) => this.activeSubtopics.has(k)).length;
    const newSubtopics = new Set(this.activeSubtopics);

    if (activeCount === 0) {
      // None active -> activate all
      fullKeys.forEach((k) => newSubtopics.add(k));
    } else {
      // Some or all active -> deactivate all
      fullKeys.forEach((k) => newSubtopics.delete(k));
    }

    this.activeSubtopics = newSubtopics;
  }

  private toggleSubtopic(topicKey: TopicKey, subtopicKey: string) {
    const fullKey = `${topicKey}.${subtopicKey}`;
    const newSubtopics = new Set(this.activeSubtopics);

    if (newSubtopics.has(fullKey)) {
      newSubtopics.delete(fullKey);
    } else {
      newSubtopics.add(fullKey);
    }

    this.activeSubtopics = newSubtopics;
  }

  private getTopicState(topicKey: TopicKey): "active" | "partial" | "inactive" {
    const topic = TOPIC_HIERARCHY[topicKey];
    const subtopicKeys = Object.keys(topic.subtopics);
    const fullKeys = subtopicKeys.map((sk) => `${topicKey}.${sk}`);
    const activeCount =
      fullKeys.filter((k) => this.activeSubtopics.has(k)).length;

    if (activeCount === 0) return "inactive";
    if (activeCount === subtopicKeys.length) return "active";
    return "partial";
  }

  private toggleAllTopics() {
    if (this.activeSubtopics.size > 0) {
      // Some selected, deselect all
      this.activeSubtopics = new Set();
    } else {
      // None selected, select all
      this.initializeAllSubtopics();
    }
  }

  private clearEvents() {
    // Dispatch event to clear telemetry in runtime
    this.dispatchEvent(
      new CustomEvent("clear-telemetry", {
        bubbles: true,
        composed: true,
      }),
    );
    // Clear local state
    this.pausedMarkers = [];
    this.expandedEvents.clear();
    this.fullHeightEvents.clear();
  }

  private togglePause() {
    this.isPaused = !this.isPaused;
    if (!this.isPaused) {
      // When unpausing, update to latest markers
      this.pausedMarkers = [...this.telemetryMarkers];
    }
  }

  private toggleEventExpand(index: number) {
    const newSet = new Set(this.expandedEvents);
    if (newSet.has(index)) {
      newSet.delete(index);
      // Also remove from full height when collapsing
      const fullHeightSet = new Set(this.fullHeightEvents);
      fullHeightSet.delete(index);
      this.fullHeightEvents = fullHeightSet;
    } else {
      newSet.add(index);
    }
    this.expandedEvents = newSet;
  }

  private toggleJsonFullHeight(index: number) {
    const newSet = new Set(this.fullHeightEvents);
    if (newSet.has(index)) {
      newSet.delete(index);
    } else {
      newSet.add(index);
    }
    this.fullHeightEvents = newSet;
  }

  private async copyJson(data: any) {
    try {
      const jsonString = JSON.stringify(data, null, 2);
      await navigator.clipboard.writeText(jsonString);
    } catch (err) {
      console.error("Failed to copy JSON:", err);
    }
  }

  private formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    return `${date.toLocaleTimeString()}.${
      date.getMilliseconds().toString().padStart(3, "0")
    }`;
  }

  private getEventIcon(marker: RuntimeTelemetryMarkerResult): string {
    const type = marker.type;

    // Try to find a matching topic
    for (const [topicKey, topic] of Object.entries(TOPIC_HIERARCHY)) {
      for (const [subtopicKey, subtopic] of Object.entries(topic.subtopics)) {
        if (type.startsWith(subtopic.pattern)) {
          return topic.icon;
        }
      }
    }

    // Default icon
    return "📊";
  }

  private getEventColor(marker: RuntimeTelemetryMarkerResult): string {
    const type = marker.type;

    // Try to find a matching topic
    for (const [topicKey, topic] of Object.entries(TOPIC_HIERARCHY)) {
      for (const [subtopicKey, subtopic] of Object.entries(topic.subtopics)) {
        if (type.startsWith(subtopic.pattern)) {
          return topic.color;
        }
      }
    }

    // Default color
    return "#64748b";
  }

  private matchesActiveTopics(marker: RuntimeTelemetryMarkerResult): boolean {
    if (this.activeSubtopics.size === 0) return false;

    const type = marker.type;

    // Check if the event matches any active subtopic
    for (const [topicKey, topic] of Object.entries(TOPIC_HIERARCHY)) {
      for (const [subtopicKey, subtopic] of Object.entries(topic.subtopics)) {
        const fullKey = `${topicKey}.${subtopicKey}`;
        if (
          this.activeSubtopics.has(fullKey) && type.startsWith(subtopic.pattern)
        ) {
          return true;
        }
      }
    }

    return false;
  }

  private matchesSearch(marker: RuntimeTelemetryMarkerResult): boolean {
    if (!this.searchText) return true;

    const searchLower = this.searchText.toLowerCase();
    const markerStr = JSON.stringify(marker).toLowerCase();
    return markerStr.includes(searchLower);
  }

  private getFilteredEvents(): RuntimeTelemetryMarkerResult[] {
    const markers = this.isPaused ? this.pausedMarkers : this.telemetryMarkers;

    return markers.filter((marker) =>
      this.matchesActiveTopics(marker) && this.matchesSearch(marker)
    );
  }

  private renderEventDetails(marker: RuntimeTelemetryMarkerResult): any {
    const details = [];

    // Extract key-value pairs from the marker (excluding type and timeStamp)
    const { type, timeStamp, ...rest } = marker;

    // Special handling for different event types
    if (type === "scheduler.run" || type === "scheduler.invocation") {
      const eventData = rest as any;
      if (eventData.action || eventData.handler) {
        const fn = eventData.action || eventData.handler;

        // Check if it's an annotated action/handler with metadata
        if (typeof fn === "object" && fn.recipe) {
          details.push(html`
            <div class="event-detail">
              <span class="event-detail-label">recipe:</span>
              <span class="event-detail-value">${fn.recipe?.name ||
              "unknown"}</span>
            </div>
          `);
          if (fn.module?.name) {
            details.push(html`
              <div class="event-detail">
                <span class="event-detail-label">module:</span>
                <span class="event-detail-value">${fn.module.name}</span>
              </div>
            `);
          }
          if (fn.reads?.length > 0) {
            details.push(html`
              <div class="event-detail">
                <span class="event-detail-label">reads:</span>
                <span class="event-detail-value">${fn.reads
                .length} dependencies</span>
              </div>
            `);
          }
          if (fn.writes?.length > 0) {
            details.push(html`
              <div class="event-detail">
                <span class="event-detail-label">writes:</span>
                <span class="event-detail-value">${fn.writes
                .length} outputs</span>
              </div>
            `);
          }
        } else if (typeof fn === "function") {
          details.push(html`
            <div class="event-detail">
              <span class="event-detail-label">function:</span>
              <span class="event-detail-value">${fn.name || "anonymous"}</span>
            </div>
          `);
        }

        if (eventData.error) {
          details.push(html`
            <div class="event-detail">
              <span class="event-detail-label">error:</span>
              <span class="event-detail-value" style="color: #ef4444;">${eventData
              .error}</span>
            </div>
          `);
        }
      }
    } else if (type === "cell.update") {
      const change = (rest as any).change;
      if (change) {
        if (change.address?.id) {
          details.push(html`
            <div class="event-detail">
              <span class="event-detail-label">cell:</span>
              <span class="event-detail-value">${change.address.id}</span>
            </div>
          `);
        }
        if (change.address?.path) {
          details.push(html`
            <div class="event-detail">
              <span class="event-detail-label">path:</span>
              <span class="event-detail-value">${change.address.path.join(
              "/",
            )}</span>
            </div>
          `);
        }
        if (change.address?.type) {
          details.push(html`
            <div class="event-detail">
              <span class="event-detail-label">type:</span>
              <span class="event-detail-value">${change.address.type}</span>
            </div>
          `);
        }
        // Show a summary of the change
        const hasBeforeAfter = change.before !== undefined ||
          change.after !== undefined;
        if (hasBeforeAfter) {
          details.push(html`
            <div class="event-detail">
              <span class="event-detail-label">change:</span>
              <span class="event-detail-value">
                ${change.before === undefined
              ? "created"
              : change.after === undefined
              ? "deleted"
              : "updated"}
              </span>
            </div>
          `);
        }
      }
    } else {
      // Default rendering for other event types
      for (const [key, value] of Object.entries(rest)) {
        if (value !== undefined && value !== null) {
          details.push(html`
            <div class="event-detail">
              <span class="event-detail-label">${key}:</span>
              <span class="event-detail-value">${typeof value === "string"
              ? value
              : typeof value === "boolean"
              ? value.toString()
              : typeof value === "number"
              ? value.toString()
              : JSON.stringify(value)}</span>
            </div>
          `);
        }
      }
    }

    return details;
  }

  private renderEvents() {
    const events = this.getFilteredEvents();

    if (events.length === 0) {
      return html`
        <div class="empty-state">
          ${this.searchText || this.activeSubtopics.size === 0
          ? "No events matching filters"
          : "No telemetry events yet"}
        </div>
      `;
    }

    // Show newest first
    const reversedEvents = [...events].reverse();

    return html`
      <div class="events-list">
        ${reversedEvents.map((marker, index) => {
        const actualIndex = events.length - 1 - index;
        const isExpanded = this.expandedEvents.has(actualIndex);
        const color = this.getEventColor(marker);

        return html`
          <div
            class="event-item ${isExpanded ? "expanded" : ""}"
            @click="${() => this.toggleEventExpand(actualIndex)}"
          >
            <div class="event-header">
              <div class="event-main">
                <span class="event-icon" style="color: ${color}">
                  ${this.getEventIcon(marker)}
                </span>
                <div class="event-content">
                  <div class="event-type">${marker.type}</div>
                  <div class="event-details">
                    ${this.renderEventDetails(marker)}
                  </div>
                </div>
              </div>
              <div class="event-time">
                ${this.formatTime(marker.timeStamp)}
              </div>
            </div>

            ${isExpanded
            ? html`
              <div class="event-expanded ${this.fullHeightEvents.has(
                  actualIndex,
                )
                ? "full-height"
                : ""}">
                <div class="json-controls">
                  <button
                    type="button"
                    class="json-control-btn"
                    @click="${(e: Event) => {
                e.stopPropagation();
                this.toggleJsonFullHeight(actualIndex);
              }}"
                  >
                    ${this.fullHeightEvents.has(actualIndex)
                ? "Collapse"
                : "Expand"}
                  </button>
                  <button
                    type="button"
                    class="json-control-btn"
                    @click="${(e: Event) => {
                e.stopPropagation();
                this.copyJson(marker);
              }}"
                  >
                    Copy
                  </button>
                </div>
                <pre>${JSON.stringify(marker, null, 2)}</pre>
              </div>
            `
            : ""}
          </div>
        `;
      })}
      </div>
    `;
  }

  override render() {
    const containerStyle = `height: ${this.resizeController.drawerHeight}px`;
    const allEvents = this.isPaused
      ? this.pausedMarkers
      : this.telemetryMarkers;
    const filteredCount = this.getFilteredEvents().length;

    return html`
      ${this.visible
        ? html`
          <div class="debugger-container" style="${containerStyle}">
            <div
              class="resize-handle"
              @mousedown="${this.resizeController.handleResizeStart}"
              @touchstart="${this.resizeController.handleTouchResizeStart}"
            >
              <div class="resize-grip"></div>
            </div>

            <div class="header-container">
              <div class="title">
                <span class="title-icon">🐛</span>
                Shell Debugger ${this.isPaused
            ? html`
              <span class="paused-indicator">PAUSED</span>
            `
            : ""}
              </div>
              <div class="stats">
                <div class="stat">
                  <span class="stat-label">Events:</span>
                  <span class="stat-value">${filteredCount} / ${allEvents
            .length}</span>
                </div>
                <div class="stat">
                  <span class="stat-label">Filters:</span>
                  <span class="stat-value">${this.activeSubtopics.size}</span>
                </div>
              </div>
            </div>

            <div class="toolbar-container">
              <div class="topics-filter">
                ${Object.entries(TOPIC_HIERARCHY).map(([key, topic]) => {
            const topicKey = key as TopicKey;
            const state = this.getTopicState(topicKey);
            const subtopicKeys = Object.keys(topic.subtopics);
            const hasDropdown = subtopicKeys.length > 0; // Show dropdown even for single subtopic
            const isDropdownOpen = this.openDropdowns.has(topicKey);

            return html`
              <div class="topic-button-group">
                <button
                  type="button"
                  class="topic-toggle ${state}"
                  style="--topic-color: ${topic.color}"
                  @click="${() => this.toggleTopic(topicKey)}"
                  title="${topic.label}"
                >
                  <span class="topic-icon">${topic.icon}</span>
                  ${topic.label} ${state === "partial"
                ? html`
                  <span style="font-size: 0.5rem; opacity: 0.7; margin-left: 0.25rem;">
                    ${Object.keys(topic.subtopics).filter((sk) =>
                    this.activeSubtopics.has(`${topicKey}.${sk}`)
                  ).length}/${subtopicKeys.length}
                  </span>
                `
                : ""}
                </button>
                ${hasDropdown
                ? html`
                  <button
                    type="button"
                    class="dropdown-trigger"
                    style="--topic-color: ${topic.color}"
                    @click="${(e: Event) => this.toggleDropdown(topicKey, e)}"
                    title="Filter subtopics"
                  >
                    ${isDropdownOpen ? "▲" : "▼"}
                  </button>
                  ${isDropdownOpen
                    ? html`
                      <div class="subtopic-dropdown" style="--topic-color: ${topic
                        .color}">
                        ${Object.entries(topic.subtopics).map(
                        ([subKey, subtopic]) => {
                          const fullKey = `${topicKey}.${subKey}`;
                          const isChecked = this.activeSubtopics.has(fullKey);
                          return html`
                            <label class="subtopic-item">
                              <input
                                type="checkbox"
                                class="subtopic-checkbox"
                                .checked="${isChecked}"
                                @change="${(e: Event) => {
                              e.stopPropagation();
                              this.toggleSubtopic(topicKey, subKey);
                            }}"
                                @click="${(e: Event) => e.stopPropagation()}"
                              />
                              ${subtopic.label}
                            </label>
                          `;
                        },
                      )}
                      </div>
                    `
                    : ""}
                `
                : ""}
              </div>
            `;
          })}
              </div>

              <div class="controls">
                <div class="search-container">
                  <input
                    type="text"
                    placeholder="Search events..."
                    class="search-input ${this.searchText ? "has-value" : ""}"
                    .value="${this.searchText}"
                    @input="${(e: Event) =>
            this.searchText = (e.target as HTMLInputElement).value}"
                  />
                  ${this.searchText
            ? html`
              <button
                type="button"
                class="clear-search"
                @click="${() => this.searchText = ""}"
              >
                ×
              </button>
            `
            : ""}
                </div>

                <button
                  type="button"
                  class="action-button"
                  @click="${this.toggleAllTopics}"
                  title="Toggle all topics"
                >
                  ${this.activeSubtopics.size > 0 ? "☐" : "☑"}
                </button>

                <button
                  type="button"
                  class="action-button"
                  @click="${this.togglePause}"
                  title="${this.isPaused ? "Resume" : "Pause"} (Space)"
                >
                  ${this.isPaused ? "▶" : "⏸"}
                </button>

                <button
                  type="button"
                  class="action-button"
                  @click="${this.clearEvents}"
                  title="Clear events"
                >
                  Clear
                </button>
              </div>
            </div>

            <div class="content-area ${this.resizeController.isResizing
            ? "resizing"
            : ""}">
              ${this.renderEvents()}
            </div>
          </div>
        `
        : ""}
    `;
  }
}

globalThis.customElements.define("x-debugger-view", XDebuggerView);
