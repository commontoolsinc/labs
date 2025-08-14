import { ReactiveController, ReactiveControllerHost } from "lit";
import type { RuntimeInternals } from "./runtime.ts";
import type { RuntimeTelemetryMarkerResult } from "@commontools/runner";

const STORAGE_KEY = "showDebuggerView";
const MAX_TELEMETRY_EVENTS = 1000; // Limit memory usage

/**
 * Controller for managing Shell Debugger state and telemetry events.
 *
 * Handles:
 * - Debugger visibility state with localStorage persistence
 * - Runtime connection and telemetry event collection
 * - Memory management by limiting event history
 */
export class DebuggerController implements ReactiveController {
  private host: ReactiveControllerHost;
  private runtime?: RuntimeInternals;
  private visible = false;
  private telemetryMarkers: RuntimeTelemetryMarkerResult[] = [];
  private updateVersion = 0;

  constructor(host: ReactiveControllerHost) {
    this.host = host;
    this.host.addController(this);
  }

  hostConnected() {
    // Load visibility from localStorage
    const savedVisible = localStorage.getItem(STORAGE_KEY);
    if (savedVisible !== null) {
      this.visible = savedVisible === "true";
    }

    // Listen for storage events (cross-tab sync)
    globalThis.addEventListener("storage", this.handleStorageChange);
  }

  hostDisconnected() {
    globalThis.removeEventListener("storage", this.handleStorageChange);
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
}
