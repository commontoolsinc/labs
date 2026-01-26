import { ReactiveController, ReactiveControllerHost } from "lit";
import type { RuntimeInternals } from "./runtime.ts";
import type {
  CellHandle,
  CellRef,
  RuntimeTelemetryMarkerResult,
  SchedulerGraphEdge,
  SchedulerGraphSnapshot,
} from "@commontools/runtime-client";

const STORAGE_KEY = "showDebuggerView";
const TELEMETRY_ENABLED_KEY = "telemetryEnabled";
const MAX_TELEMETRY_EVENTS = 1000; // Limit memory usage

/**
 * Extended graph edge with historical tracking
 */
export interface GraphEdgeWithHistory extends SchedulerGraphEdge {
  isHistorical: boolean; // true = edge existed before but not in current snapshot
}

/**
 * Graph snapshot with historical edge tracking
 */
export interface GraphWithHistory {
  nodes: SchedulerGraphSnapshot["nodes"];
  edges: GraphEdgeWithHistory[];
  pullMode: boolean;
  timestamp: number;
}

/**
 * Represents a watched cell with subscription management
 */
export interface WatchedCell {
  id: string; // Unique watch entry ID (e.g., "watch-{timestamp}-{random}")
  cellLink: CellRef; // The cell being watched (for display/persistence)
  label?: string; // User-provided label
  cell: CellHandle; // Live cell reference for subscription
  cancel?: () => void; // Cleanup from cell.sink()
  lastValue?: unknown; // Most recent value
  lastUpdate?: number; // Timestamp of last update
  updateCount: number; // Update counter
}

/**
 * Controller for managing Shell Debugger state and telemetry events.
 *
 * Handles:
 * - Debugger visibility state with localStorage persistence
 * - Runtime connection and telemetry event collection
 * - Memory management by limiting event history
 * - Watched cell subscriptions with console logging
 */
export class DebuggerController implements ReactiveController {
  private host: ReactiveControllerHost & HTMLElement;
  private runtime?: RuntimeInternals;
  private visible = false;
  private telemetryEnabled = false; // Manual telemetry on/off
  private telemetryMarkers: RuntimeTelemetryMarkerResult[] = [];
  private updateVersion = 0;
  private watchedCells = new Map<string, WatchedCell>();

  // Scheduler graph tracking with historical edges
  private currentSnapshot?: SchedulerGraphSnapshot;
  private historicalEdges = new Set<string>(); // "from->to" format
  private graphUpdateVersion = 0;
  private isProcessingTelemetry = false; // Guard against re-entrant updates

  // Baseline stats for scheduler graph delta calculations
  // Persists across tab switches (stored here instead of in SchedulerGraphView component)
  private schedulerBaselineStats = new Map<
    string,
    { runCount: number; totalTime: number }
  >();
  private schedulerBaselineVersion = 0;

  constructor(host: ReactiveControllerHost & HTMLElement) {
    this.host = host;
    this.host.addController(this);
  }

  hostConnected() {
    // Load visibility from localStorage
    const savedVisible = localStorage.getItem(STORAGE_KEY);
    if (savedVisible !== null) {
      this.visible = savedVisible === "true";
    }

    // Load telemetry enabled state from localStorage (default to false)
    const savedTelemetryEnabled = localStorage.getItem(TELEMETRY_ENABLED_KEY);
    if (savedTelemetryEnabled !== null) {
      this.telemetryEnabled = savedTelemetryEnabled === "true";
    }

    globalThis.addEventListener("storage", this.handleStorageChange);
    this.host.addEventListener("ct-cell-watch", this.handleCellWatch);
    this.host.addEventListener("ct-cell-unwatch", this.handleCellUnwatch);
    this.host.addEventListener("clear-telemetry", this.handleClearTelemetry);
  }

  hostDisconnected() {
    globalThis.removeEventListener("storage", this.handleStorageChange);
    this.host.removeEventListener("ct-cell-watch", this.handleCellWatch);
    this.host.removeEventListener("ct-cell-unwatch", this.handleCellUnwatch);
    this.host.removeEventListener("clear-telemetry", this.handleClearTelemetry);
    // Clean up all watched cell subscriptions to prevent memory leaks
    this.unwatchAll();
  }

  /**
   * Set the runtime and start listening to telemetry events
   */
  setRuntime(runtime: RuntimeInternals) {
    if (this.runtime) {
      this.runtime.removeEventListener(
        "telemetryupdate",
        this.handleTelemetryUpdate,
      );
      // Clean up all watched cell subscriptions when runtime disconnects
      this.unwatchAll();
    }

    this.runtime = runtime;

    if (this.runtime) {
      this.runtime.addEventListener(
        "telemetryupdate",
        this.handleTelemetryUpdate,
      );

      // Set telemetry enabled state based on saved preference
      const rt = this.runtime.runtime();
      rt.setTelemetryEnabled(this.telemetryEnabled).catch((e) => {
        console.error(
          "[DebuggerController] Failed to set telemetry enabled:",
          e,
        );
      });

      // Load existing telemetry markers
      this.telemetryMarkers = this.runtime.telemetry().slice(
        -MAX_TELEMETRY_EVENTS,
      );
      this.updateVersion++;
      this.host.requestUpdate();
    }
  }

  /**
   * Get the current telemetry markers
   */
  getTelemetryMarkers(): RuntimeTelemetryMarkerResult[] {
    return this.telemetryMarkers;
  }

  /**
   * Get the update version for change detection
   */
  getUpdateVersion(): number {
    return this.updateVersion;
  }

  /**
   * Check if the debugger is visible
   */
  isVisible(): boolean {
    return this.visible;
  }

  /**
   * Toggle debugger visibility
   */
  toggleVisibility() {
    this.setVisibility(!this.visible);
  }

  /**
   * Set debugger visibility
   */
  setVisibility(visible: boolean) {
    if (this.visible === visible) return;

    this.visible = visible;
    localStorage.setItem(STORAGE_KEY, String(visible));
    this.host.requestUpdate();
  }

  /**
   * Clear all telemetry events
   */
  clearTelemetry() {
    this.telemetryMarkers = [];
    this.updateVersion++;
    this.host.requestUpdate();
  }

  /**
   * Check if telemetry is enabled
   */
  isTelemetryEnabled(): boolean {
    return this.telemetryEnabled;
  }

  /**
   * Toggle telemetry collection on/off
   */
  toggleTelemetry() {
    this.setTelemetryEnabled(!this.telemetryEnabled);
  }

  /**
   * Set telemetry enabled state
   */
  setTelemetryEnabled(enabled: boolean) {
    if (this.telemetryEnabled === enabled) return;

    this.telemetryEnabled = enabled;
    localStorage.setItem(TELEMETRY_ENABLED_KEY, String(enabled));

    // Update telemetry collection in the worker
    const rt = this.runtime?.runtime();
    if (rt) {
      rt.setTelemetryEnabled(enabled).catch((e) => {
        console.error(
          "[DebuggerController] Failed to set telemetry enabled:",
          e,
        );
      });
    }

    this.host.requestUpdate();
  }

  /**
   * Handle telemetry updates from the runtime
   */
  private handleTelemetryUpdate = () => {
    // Guard against re-entrant updates (telemetry -> UI update -> sink -> telemetry)
    if (this.isProcessingTelemetry) return;

    if (this.runtime) {
      this.isProcessingTelemetry = true;
      try {
        // Get all telemetry markers from runtime
        const allMarkers = this.runtime.telemetry();

        // Limit to maximum number of events to prevent memory issues
        this.telemetryMarkers = allMarkers.slice(-MAX_TELEMETRY_EVENTS);
        this.updateVersion++;

        // Check for graph snapshot events in recent markers
        const latestMarker = allMarkers[allMarkers.length - 1];
        if (latestMarker?.type === "scheduler.graph.snapshot") {
          this.processGraphSnapshot(
            (latestMarker as { graph: SchedulerGraphSnapshot }).graph,
          );
        }

        // NOTE: Auto-refresh disabled - was causing infinite loop
        // (telemetry -> UI update -> sink -> telemetry)
        // Use manual refresh button instead
        // if (
        //   latestMarker?.type === "scheduler.run" ||
        //   latestMarker?.type === "scheduler.invocation" ||
        //   latestMarker?.type === "scheduler.mode.change" ||
        //   latestMarker?.type === "scheduler.subscribe" ||
        //   latestMarker?.type === "scheduler.dependencies.update"
        // ) {
        //   const rt = this.runtime.runtime();
        //   if (rt) {
        //     const snapshot = rt.scheduler.getGraphSnapshot();
        //     this.processGraphSnapshot(snapshot);
        //   }
        // }

        // Request update to refresh the UI
        //this.host.requestUpdate();
      } finally {
        this.isProcessingTelemetry = false;
      }
    }
  };

  /**
   * Process a new graph snapshot and track historical edges
   */
  private processGraphSnapshot(newSnapshot: SchedulerGraphSnapshot): void {
    if (this.currentSnapshot) {
      // Build set of current edges in the new snapshot
      const newEdgeSet = new Set(
        newSnapshot.edges.map((e) => `${e.from}->${e.to}`),
      );

      // Any edges in the old snapshot but not in the new one become historical
      for (const edge of this.currentSnapshot.edges) {
        const edgeKey = `${edge.from}->${edge.to}`;
        if (!newEdgeSet.has(edgeKey)) {
          this.historicalEdges.add(edgeKey);
        }
      }
    }

    this.currentSnapshot = newSnapshot;
    this.graphUpdateVersion++;
  }

  /**
   * Handle storage change events for cross-tab synchronization
   */
  private handleStorageChange = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY && event.newValue !== null) {
      const newVisible = event.newValue === "true";
      if (this.visible !== newVisible) {
        this.visible = newVisible;
        this.host.requestUpdate();
      }
    }
  };

  /**
   * Get statistics about telemetry events
   */
  getStatistics() {
    const eventTypes = new Map<string, number>();

    for (const marker of this.telemetryMarkers) {
      const type = marker.type.split(".")[0]; // Get the main category
      eventTypes.set(type, (eventTypes.get(type) || 0) + 1);
    }

    return {
      totalEvents: this.telemetryMarkers.length,
      eventTypes: Object.fromEntries(eventTypes),
      oldestEvent: this.telemetryMarkers[0]?.timeStamp,
      newestEvent: this.telemetryMarkers[this.telemetryMarkers.length - 1]
        ?.timeStamp,
    };
  }

  /**
   * Get the current graph snapshot with historical edge tracking
   */
  getGraphWithHistory(): GraphWithHistory | undefined {
    if (!this.currentSnapshot) return undefined;

    // Build set of current edge keys
    const currentEdgeSet = new Set(
      this.currentSnapshot.edges.map((e) => `${e.from}->${e.to}`),
    );

    // Combine current edges with historical flag
    const edges: GraphEdgeWithHistory[] = this.currentSnapshot.edges.map(
      (e) => ({
        ...e,
        isHistorical: false,
      }),
    );

    // Add historical edges that are not in current snapshot
    for (const edgeKey of this.historicalEdges) {
      if (!currentEdgeSet.has(edgeKey)) {
        const [from, to] = edgeKey.split("->");
        edges.push({
          from,
          to,
          cells: [],
          isHistorical: true,
        });
      }
    }

    return {
      nodes: this.currentSnapshot.nodes,
      edges,
      pullMode: this.currentSnapshot.pullMode,
      timestamp: this.currentSnapshot.timestamp,
    };
  }

  /**
   * Get the graph update version for change detection
   */
  getGraphUpdateVersion(): number {
    return this.graphUpdateVersion;
  }

  /**
   * Request a fresh graph snapshot from the scheduler
   */
  async requestGraphSnapshot(): Promise<void> {
    if (!this.runtime) return;

    const rt = this.runtime.runtime();
    if (!rt) return;
    const snapshot = await rt.getGraphSnapshot();
    this.processGraphSnapshot(snapshot);
    this.host.requestUpdate();
  }

  /**
   * Get the current runtime internals
   */
  getRuntime(): RuntimeInternals | undefined {
    return this.runtime;
  }

  /**
   * Clear historical edges
   */
  clearHistoricalEdges(): void {
    this.historicalEdges.clear();
    this.graphUpdateVersion++;
    this.host.requestUpdate();
  }

  /**
   * Get the scheduler baseline stats for delta calculations
   */
  getSchedulerBaselineStats(): Map<
    string,
    { runCount: number; totalTime: number }
  > {
    return this.schedulerBaselineStats;
  }

  /**
   * Set new scheduler baseline stats
   */
  setSchedulerBaselineStats(
    stats: Map<string, { runCount: number; totalTime: number }>,
  ): void {
    this.schedulerBaselineStats = stats;
    this.schedulerBaselineVersion++;
    this.host.requestUpdate();
  }

  /**
   * Clear the scheduler baseline stats
   */
  clearSchedulerBaselineStats(): void {
    this.schedulerBaselineStats.clear();
    this.schedulerBaselineVersion++;
    this.host.requestUpdate();
  }

  /**
   * Get the scheduler baseline version for change detection
   */
  getSchedulerBaselineVersion(): number {
    return this.schedulerBaselineVersion;
  }

  /**
   * Export telemetry data as JSON
   */
  exportTelemetry(): string {
    return JSON.stringify(this.telemetryMarkers, null, 2);
  }

  /**
   * Download telemetry data as a JSON file
   */
  downloadTelemetry() {
    const data = this.exportTelemetry();
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `telemetry-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Watch a cell for changes. Subscribes to the cell and logs updates to console.
   * @param cell - The cell to watch
   * @param label - Optional label for identifying this watch
   * @returns The watch ID (can be used to unwatch later)
   */
  watchCell(cell: CellHandle, label?: string): string {
    // Generate unique watch ID
    const watchId = `watch-${Date.now()}-${
      Math.random().toString(36).slice(2, 8)
    }`;

    // Get the cell link for display/persistence
    const cellLink = cell.ref();

    // Create identifier for logging (use label if provided, otherwise short ID)
    const identifier = label ?? this.getCellShortId(cellLink);

    // Subscribe to cell changes
    const cancel = cell.subscribe((value) => {
      const watch = this.watchedCells.get(watchId);
      if (!watch) return;

      watch.updateCount++;
      watch.lastValue = value;
      watch.lastUpdate = Date.now();

      console.log(
        `[DebuggerController] Watch update: ${identifier} (#${watch.updateCount}):`,
        value,
      );

      // Request UI update
      this.host.requestUpdate();
    });

    // Store the watch entry
    const watchedCell: WatchedCell = {
      id: watchId,
      cellLink,
      label,
      cell,
      cancel,
      lastValue: undefined,
      lastUpdate: undefined,
      updateCount: 0,
    };

    this.watchedCells.set(watchId, watchedCell);

    console.log(`[DebuggerController] Started watching: ${identifier}`);

    // Request UI update
    this.host.requestUpdate();

    return watchId;
  }

  /**
   * Stop watching a cell
   * @param watchId - The watch ID returned by watchCell()
   */
  unwatchCell(watchId: string): void {
    const watch = this.watchedCells.get(watchId);
    if (!watch) return;

    // Clean up subscription
    if (watch.cancel) {
      watch.cancel();
    }

    const identifier = watch.label ?? this.getCellShortId(watch.cellLink);
    console.log(`[DebuggerController] Stopped watching: ${identifier}`);

    // Remove from map
    this.watchedCells.delete(watchId);

    // Request UI update
    this.host.requestUpdate();
  }

  /**
   * Stop watching all cells
   */
  unwatchAll(): void {
    const hadWatches = this.watchedCells.size > 0;

    for (const watchId of this.watchedCells.keys()) {
      const watch = this.watchedCells.get(watchId);
      if (watch?.cancel) {
        watch.cancel();
      }
    }

    this.watchedCells.clear();

    if (hadWatches) {
      console.log("[DebuggerController] Stopped watching all cells");
      // Request UI update
      this.host.requestUpdate();
    }
  }

  /**
   * Get all currently watched cells
   */
  getWatchedCells(): WatchedCell[] {
    return Array.from(this.watchedCells.values());
  }

  /**
   * Generate a short ID from a cell link for display purposes
   */
  private getCellShortId(link: CellRef): string {
    const shortId = link.id.split(":").pop()?.slice(-6) ?? "???";
    return `#${shortId}`;
  }

  private handleCellWatch = (e: Event) => {
    const event = e as CustomEvent<{ cell: unknown; label?: string }>;
    const { cell, label } = event.detail;
    // Cell type from @commontools/runner
    if (cell && typeof (cell as any).sink === "function") {
      this.watchCell(cell as any, label);
    }
  };

  private handleCellUnwatch = (e: Event) => {
    const event = e as CustomEvent<{ cell: unknown; label?: string }>;
    const { cell } = event.detail;
    // Find and remove the watch by matching the cell
    if (cell && typeof (cell as any).ref === "function") {
      const link = (cell as any).ref();
      const watches = this.getWatchedCells();
      const watch = watches.find((w) => w.cellLink.id === link.id);
      if (watch) {
        this.unwatchCell(watch.id);
      }
    }
  };

  private handleClearTelemetry = () => {
    this.clearTelemetry();
  };
}
