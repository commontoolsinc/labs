import { ReactiveController, ReactiveControllerHost } from "lit";
import type { RuntimeInternals } from "./runtime.ts";
import type {
  Cell,
  MemorySpace,
  NormalizedLink,
  RuntimeTelemetryMarkerResult,
} from "@commontools/runner";

const STORAGE_KEY = "showDebuggerView";
const MAX_TELEMETRY_EVENTS = 1000; // Limit memory usage

/**
 * A normalized link with both id and space defined (suitable as a memory address)
 */
type NormalizedFullLink = NormalizedLink & {
  id: string;
  space: MemorySpace;
};

/**
 * Represents a watched cell with subscription management
 */
export interface WatchedCell {
  id: string; // Unique watch entry ID (e.g., "watch-{timestamp}-{random}")
  cellLink: NormalizedFullLink; // The cell being watched (for display/persistence)
  label?: string; // User-provided label
  cell: Cell; // Live cell reference for subscription
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
  private telemetryMarkers: RuntimeTelemetryMarkerResult[] = [];
  private updateVersion = 0;
  private watchedCells = new Map<string, WatchedCell>();

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
   * Handle telemetry updates from the runtime
   */
  private handleTelemetryUpdate = () => {
    if (this.runtime) {
      // Get all telemetry markers from runtime
      const allMarkers = this.runtime.telemetry();

      // Limit to maximum number of events to prevent memory issues
      this.telemetryMarkers = allMarkers.slice(-MAX_TELEMETRY_EVENTS);
      this.updateVersion++;

      // Request update to refresh the UI
      this.host.requestUpdate();
    }
  };

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
  watchCell(cell: Cell, label?: string): string {
    // Generate unique watch ID
    const watchId = `watch-${Date.now()}-${
      Math.random().toString(36).slice(2, 8)
    }`;

    // Get the cell link for display/persistence
    const cellLink = cell.getAsNormalizedFullLink();

    // Create identifier for logging (use label if provided, otherwise short ID)
    const identifier = label ?? this.getCellShortId(cellLink);

    // Subscribe to cell changes
    const cancel = cell.sink((value) => {
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
  private getCellShortId(link: NormalizedFullLink): string {
    const id = link.id;
    const shortId = id.split(":").pop()?.slice(-6) ?? "???";
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
    if (cell && typeof (cell as any).getAsNormalizedFullLink === "function") {
      const link = (cell as any).getAsNormalizedFullLink();
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
