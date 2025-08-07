import { ReactiveController, ReactiveControllerHost } from "lit";
import { TelemetryBasedInspector } from "./telemetry-inspector.ts";
import type { RuntimeInternals } from "./runtime.ts";

const STORAGE_KEY = "showTelemetryInspectorView";

/**
 * Controller for managing telemetry-based inspector state and visibility.
 * 
 * This is the next-generation inspector that uses RuntimeTelemetry events
 * instead of direct storage inspector state.
 * 
 * Handles:
 * - Telemetry event processing and state derivation
 * - Inspector visibility state with localStorage persistence
 * - Cross-tab synchronization via storage events
 * - Runtime connection and telemetry updates
 */
export class TelemetryInspectorController implements ReactiveController {
  private host: ReactiveControllerHost;
  private runtime?: RuntimeInternals;
  private inspector: TelemetryBasedInspector;
  private visible = false;
  private updateVersion = 0;

  constructor(host: ReactiveControllerHost) {
    this.host = host;
    this.inspector = new TelemetryBasedInspector();
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
      
      // Process any existing telemetry markers
      this.inspector.processMarkers(this.runtime.telemetry());
      this.updateVersion++;
      this.host.requestUpdate();
    }
  }

  /**
   * Get the current telemetry-derived state
   */
  getState() {
    return this.inspector.getState();
  }

  /**
   * Get the telemetry-based inspector instance
   */
  getInspector(): TelemetryBasedInspector {
    return this.inspector;
  }

  /**
   * Get the update version for change detection
   */
  getUpdateVersion(): number {
    return this.updateVersion;
  }

  /**
   * Check if the inspector is visible
   */
  isVisible(): boolean {
    return this.visible;
  }

  /**
   * Toggle inspector visibility
   */
  toggleVisibility() {
    this.setVisibility(!this.visible);
  }

  /**
   * Set inspector visibility
   */
  setVisibility(visible: boolean) {
    if (this.visible === visible) return;

    this.visible = visible;
    localStorage.setItem(STORAGE_KEY, String(visible));
    this.host.requestUpdate();
  }

  /**
   * Clear all telemetry and state
   */
  clear() {
    this.inspector.clear();
    this.updateVersion++;
    this.host.requestUpdate();
  }

  /**
   * Handle telemetry updates from the runtime
   */
  private handleTelemetryUpdate = () => {
    if (this.runtime) {
      // Process the updated telemetry markers
      this.inspector.processMarkers(this.runtime.telemetry());
      this.updateVersion++;
      
      // Request update to ensure new operations are shown immediately
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
   * Get statistics about current operations
   */
  getStatistics() {
    const state = this.inspector.getState();
    return {
      activeCount: state.activeOperations.size,
      completedCount: state.completedOperations.length,
      errorCount: state.errors.length,
      subscriptionCount: state.subscriptions.size,
      connectionStatus: state.connectionStatus.status,
      hasActiveOperations: this.inspector.hasActiveOperations(),
    };
  }

  /**
   * Check if there are any errors
   */
  hasErrors(): boolean {
    return this.inspector.getState().errors.length > 0;
  }

  /**
   * Get operations filtered by type
   */
  getOperationsByType(type: "push" | "pull") {
    return this.inspector.getOperationsByType(type);
  }

  /**
   * Get operations filtered by status
   */
  getOperationsByStatus(status: "active" | "completed" | "error") {
    return this.inspector.getOperationsByStatus(status);
  }
}