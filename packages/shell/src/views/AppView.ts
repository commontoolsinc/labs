import { css, html } from "lit";
import { Task, TaskStatus } from "@lit/task";
import { state } from "lit/decorators.js";
import { consume } from "@lit/context";

import { CharmsController } from "@commontools/charm/ops";
import * as Inspector from "@commontools/runner/storage/inspector";

import { AppState } from "../lib/app/mod.ts";
import { appContext } from "../contexts/app.ts";
import { BaseView } from "./BaseView.ts";
import { createCharmsController } from "../lib/runtime.ts";

export class XAppView extends BaseView {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
    }

    .shell-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      background-color: white;
      border: var(--border-width, 2px) solid var(--border-color, #000);
    }

    .content-area {
      flex: 1;
      overflow-y: auto;
      background-color: white;
    }
  `;

  @consume({ context: appContext, subscribe: true })
  @state()
  private app?: AppState;

  // Track the current controller to ensure proper cleanup when app state changes.
  // This prevents WebSocket connection leaks and ensures only one runtime exists
  // at a time, avoiding resource exhaustion and potential conflicts.
  private _currentController: CharmsController | null = null;

  // Storage broadcast channel for receiving status updates
  private _storageChannel: Inspector.Channel | null = null;

  // Storage status monitoring for conflict detection
  @state()
  private _storageStatus = Inspector.create();

  // Update storage status from broadcast events
  private _updateStorageStatus = (command: Inspector.BroadcastCommand) => {
    Inspector.update(this._storageStatus, command);

    // Log conflict detection
    const pushErrorCount = Object.values(this._storageStatus.push).filter(
      (v) => v.error,
    ).length;
    const pullErrorCount = Object.values(this._storageStatus.pull).filter(
      (v) => v.error,
    ).length;

    if (pushErrorCount > 0 || pullErrorCount > 0) {
      console.log("[AppView] Conflict detected:", {
        pushErrors: pushErrorCount,
        pullErrors: pullErrorCount,
        pushDetails: Object.entries(this._storageStatus.push)
          .filter(([_, v]) => v.error)
          .map(([id, v]) => ({ id, error: v.error })),
        pullDetails: Object.entries(this._storageStatus.pull)
          .filter(([_, v]) => v.error)
          .map(([id, v]) => ({ id, error: v.error })),
      });
    }

    this.requestUpdate();
  };

  // Track previous connection status for change detection
  private _previousConnectionStatus: string | undefined;

  // Get the current connection status based on task state
  get connectionStatus():
    | "connecting"
    | "connected"
    | "disconnected"
    | "error"
    | "conflict" {
    // Check for conflicts (push/pull errors) - filter once for efficiency
    const pushErrors = Object.values(this._storageStatus.push).filter(
      (v) => v.error,
    );
    const pullErrors = Object.values(this._storageStatus.pull).filter(
      (v) => v.error,
    );
    const hasConflict = pushErrors.length > 0 || pullErrors.length > 0;

    let status:
      | "connecting"
      | "connected"
      | "disconnected"
      | "error"
      | "conflict";

    // Determine base status from task
    switch (this._cc.status) {
      case TaskStatus.INITIAL:
      case TaskStatus.PENDING:
        status = "connecting";
        break;
      case TaskStatus.COMPLETE:
        status = this._cc.value ? "connected" : "disconnected";
        break;
      case TaskStatus.ERROR:
        status = "error";
        break;
      default:
        status = "disconnected";
    }

    // Override with conflict if present and connected
    if (hasConflict && status === "connected") {
      status = "conflict";
    }

    // Log status changes
    if (this._previousConnectionStatus !== status) {
      console.log("[AppView] Connection status changed:", {
        from: this._previousConnectionStatus,
        to: status,
        timestamp: new Date().toISOString(),
      });
      this._previousConnectionStatus = status;
    }

    return status;
  }

  private _cc = new Task(this, {
    task: async ([app]) => {
      console.log("[AppView] Task triggered with app state:", {
        hasIdentity: !!app?.identity,
        identityDid: app?.identity?.did(),
        spaceName: app?.spaceName,
        apiUrl: app?.apiUrl?.toString(),
      });

      if (!app || !app.identity || !app.spaceName || !app.apiUrl) {
        console.log(
          "[AppView] Missing required app state, cleaning up controller",
        );
        await this._cleanupController();
        return undefined;
      }

      console.log(
        "[AppView] Creating new CharmsController for space:",
        app.spaceName,
      );
      await this._cleanupController();

      const controller = await createCharmsController({
        identity: app.identity,
        spaceName: app.spaceName,
        apiUrl: app.apiUrl,
      });

      console.log("[AppView] CharmsController created successfully");
      this._currentController = controller;

      // Set up storage broadcast listener for conflict detection
      console.log("[AppView] Attempting to set up storage broadcast listener");

      const charmManager = controller.manager();
      console.log("[AppView] CharmManager exists:", !!charmManager);

      if (charmManager) {
        const runtime = charmManager.runtime;
        console.log("[AppView] Runtime exists:", !!runtime);
        console.log("[AppView] Runtime ID:", runtime?.id);

        if (runtime?.id) {
          // Close any existing channel before creating a new one
          if (this._storageChannel) {
            this._storageChannel.close();
          }

          try {
            // Create new channel for storage status updates
            this._storageChannel = new Inspector.Channel(
              runtime.id,
              this._updateStorageStatus,
            );
            console.log(
              "[AppView] Subscribed to storage status updates with ID:",
              runtime.id,
            );
          } catch (error) {
            console.error("[AppView] Failed to create storage channel:", error);
            // Continue without storage monitoring - app still functions
          }
        } else {
          console.log("[AppView] No runtime ID available for subscription");
        }
      } else {
        console.log("[AppView] No CharmManager found on controller");
      }

      return controller;
    },
    args: () => [this.app],
  });

  // Clean up the previous controller and its runtime to free resources.
  // This disposes of WebSocket connections and other runtime resources.
  private async _cleanupController(): Promise<void> {
    if (!this._currentController) return;

    try {
      const charmManager = this._currentController.manager();

      if (charmManager?.runtime) {
        // Close storage broadcast channel
        if (this._storageChannel) {
          this._storageChannel.close();
          this._storageChannel = null;
          console.log("[AppView] Closed storage status update channel");
        }

        if (charmManager.runtime.dispose) {
          await charmManager.runtime.dispose();
        }
      }
    } catch (error) {
      console.error("Error cleaning up CharmsController:", error);
    } finally {
      this._currentController = null;
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    // Close any open storage channel
    if (this._storageChannel) {
      this._storageChannel.close();
      this._storageChannel = null;
    }
    this._cleanupController();
  }

  override render() {
    const cc = this._cc.value;
    const app = (this.app ?? {}) as AppState;
    const unauthenticated = html`
      <x-login-view></x-login-view>
    `;
    const authenticated = html`
      <x-body
        .cc="${cc}"
        .activeCharmId="${app.activeCharmId}"
      ></x-body>
    `;

    const content = this.app?.identity ? authenticated : unauthenticated;
    return html`
      <div class="shell-container">
        <x-header
          .identity="${app.identity}"
          .connectionStatus="${this.connectionStatus}"
        ></x-header>
        <div class="content-area">
          ${content}
        </div>
      </div>
    `;
  }
}

globalThis.customElements.define("x-app-view", XAppView);
