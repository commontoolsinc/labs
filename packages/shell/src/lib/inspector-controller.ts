import { ReactiveController, ReactiveControllerHost } from "lit";
import {
  StorageInspectorState,
  StorageInspectorUpdateEvent,
} from "./storage-inspector.ts";
import { RuntimeInternals } from "./runtime.ts";

const STORAGE_KEY = "showInspectorView";

/**
 * Controller for managing inspector state and visibility.
 *
 * Handles:
 * - Inspector visibility state with localStorage persistence
 * - Cross-tab synchronization via storage events
 * - Runtime connection and inspector state updates
 */
export class StorageInspectorController implements ReactiveController {
  private host: ReactiveControllerHost;
  private runtime?: RuntimeInternals;
  private inspectorState?: StorageInspectorState;
  private visible = false;
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

  setRuntime(runtime: RuntimeInternals) {
    if (this.runtime) {
      this.runtime.removeEventListener(
        "inspectorupdate",
        this.handleInspectorUpdate,
      );
    }

    this.runtime = runtime;

    if (this.runtime) {
      this.runtime.addEventListener(
        "inspectorupdate",
        this.handleInspectorUpdate,
      );
    }
  }

  getState(): StorageInspectorState | undefined {
    return this.inspectorState;
  }

  getUpdateVersion(): number {
    return this.updateVersion;
  }

  isVisible(): boolean {
    return this.visible;
  }

  toggleVisibility() {
    this.setVisibility(!this.visible);
  }

  setVisibility(visible: boolean) {
    if (this.visible === visible) return;

    this.visible = visible;
    localStorage.setItem(STORAGE_KEY, String(visible));
    this.host.requestUpdate();
  }

  private handleInspectorUpdate = (event: Event) => {
    if (event instanceof StorageInspectorUpdateEvent) {
      this.inspectorState = event.detail.model;
      this.updateVersion++;
      // Request update to ensure new operations are shown immediately
      this.host.requestUpdate();
    }
  };

  private handleStorageChange = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY && event.newValue !== null) {
      const newVisible = event.newValue === "true";
      if (this.visible !== newVisible) {
        this.visible = newVisible;
        this.host.requestUpdate();
      }
    }
  };
}
