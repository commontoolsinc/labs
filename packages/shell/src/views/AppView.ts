import { css, html } from "lit";
import { Task } from "@lit/task";
import { state } from "lit/decorators.js";
import { consume } from "@lit/context";

import { CharmsController } from "@commontools/charm/ops";

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

      return controller;
    },
    args: () => [this.app],
  });

  // Clean up the previous controller and its runtime to free resources.
  // This disposes of WebSocket connections and other runtime resources.
  private async _cleanupController(): Promise<void> {
    if (!this._currentController) return;

    try {
      const charmManager = (this._currentController as any).charmManager;
      if (charmManager?.runtime?.dispose) {
        await charmManager.runtime.dispose();
      }
    } catch (error) {
      console.error("Error cleaning up CharmsController:", error);
    } finally {
      this._currentController = null;
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._cleanupController();
  }

  override render() {
    const cc = this._cc.value;
    const app = (this.app ?? {}) as AppState;
    const unauthenticated = html`
      <x-login-view .keyStore="${app.keyStore}"></x-login-view>
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
        <x-header .identity="${app.identity}"></x-header>
        <div class="content-area">
          ${content}
        </div>
      </div>
    `;
  }
}

globalThis.customElements.define("x-app-view", XAppView);
