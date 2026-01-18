import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { KeyStore } from "@commontools/identity";
import { BaseView } from "./BaseView.ts";
import { RuntimeInternals } from "../lib/runtime.ts";
import "../components/Flex.ts";

type ConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error"
  | "conflict";

export class XHeaderView extends BaseView {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: auto;
      border-bottom: var(--border-width, 2px) solid var(--border-color, #000);
      transition: background-color 0.3s ease;
      cursor: pointer;
    }

    #header {
      background-color: var(--header-bg-color, #f9fafb);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.5rem;
      gap: 0.5rem;
    }

    .left-section {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .button-group {
      display: flex;
      align-items: center;
      gap: 3px;
    }

    .button-group > * {
      flex: none;
    }

    x-button.emoji-button {
      opacity: 0.7;
      transition: opacity 0.2s;
      font-size: 1rem;
    }

    x-button.emoji-button:hover {
      opacity: 1;
    }

    x-button.auth-button {
      font-size: 1rem;
    }

    .reload-icon {
      cursor: pointer;
      opacity: 0.5;
      transition: opacity 0.2s;
      user-select: none;
      font-size: 0.9rem;
      margin-left: 0.25rem;
    }

    .reload-icon:hover {
      opacity: 1;
    }

    #page-title {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-primary, #000);
      font-weight: 700;
      margin: 0;
      user-select: none;
    }

    ct-logo {
      cursor: pointer;
      transition: transform 0.2s ease;
    }

    ct-logo:hover {
      transform: scale(1.05);
    }
  `;

  @property()
  private keyStore?: KeyStore;

  @property()
  private rt?: RuntimeInternals;

  @property({ attribute: false })
  charmTitle?: string;

  @property({ attribute: false })
  charmId?: string;

  @property({ attribute: false })
  spaceName?: string;

  @property({ attribute: false })
  isLoggedIn = false;

  @property()
  showDebuggerView = false;

  @property()
  showSidebar = false;

  @property({ attribute: false })
  isViewingDefaultPattern = false;

  private handleAuthClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    if (!this.keyStore) {
      console.warn("Could not clear keystore.");
    } else {
      this.keyStore.clear().catch(console.error);
    }
    this.command({ type: "set-identity", identity: undefined });
  }

  private handleDebuggerToggleClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.command({
      type: "set-config",
      key: "showDebuggerView",
      value: !this.showDebuggerView,
    });
  }

  private handleSidebarToggleClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.command({
      type: "set-config",
      key: "showSidebar",
      value: !this.showSidebar,
    });
  }

  private async handleReloadPatternClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    if (!this.rt) return;
    try {
      await this.rt.recreateSpaceRootPattern();
      // Dispatch event to notify AppView to refresh the pattern
      this.dispatchEvent(
        new CustomEvent("pattern-recreated", { bubbles: true, composed: true }),
      );
    } catch (err) {
      console.error("[HeaderView] Failed to recreate pattern:", err);
    }
  }

  private getConnectionStatus(): ConnectionStatus {
    return this.rt ? "connected" : "disconnected";
  }

  override render() {
    const spaceLink = this.spaceName
      ? html`
        <x-charm-link id="header-space-link" .spaceName="${this.spaceName}"
        >${this
          .spaceName}</x-charm-link>
      `
      : null;
    const charmLink = this.charmId && this.spaceName
      ? html`
        <x-charm-link
          id="header-charm-link"
          .charmId="${this.charmId}"
          .spaceName="${this.spaceName}"
        >${this.charmTitle || this.charmId}</x-charm-link>
      `
      : null;
    const reloadIcon = this.isViewingDefaultPattern && this.isLoggedIn
      ? html`
        <span
          class="reload-icon"
          @click="${this.handleReloadPatternClick}"
          title="Reload default pattern"
        >↻</span>
      `
      : null;

    const title = html`
      <h1 id="page-title">
        ${spaceLink}${charmLink ? " / " : ""}${charmLink}${reloadIcon}
      </h1>
    `;

    const connectionStatus = this.getConnectionStatus();
    const connectionColor = getConnectionColor(connectionStatus);

    return html`
      <div id="header">
        <div class="left-section">
          <ct-logo .backgroundColor="${connectionColor}"></ct-logo>
          ${title}
        </div>
        ${this.isLoggedIn
          ? html`
            <div class="button-group">
              <x-button
                class="emoji-button"
                size="small"
                @click="${this.handleSidebarToggleClick}"
                title="${this.showSidebar ? "Hide Sidebar" : "Show Sidebar"}"
              >
                ${this.showSidebar ? "⏵" : "⏴"}
              </x-button>
              ${this.charmId
                ? html`
                  <x-favorite-button
                    .charmId="${this.charmId}"
                    .rt="${this.rt}"
                  ></x-favorite-button>
                `
                : null}
              <x-button
                class="emoji-button"
                size="small"
                @click="${this.handleDebuggerToggleClick}"
                title="${this.showDebuggerView
                  ? "Hide Debugger"
                  : "Show Debugger"}"
              >
                ${this.showDebuggerView ? "🐛" : "🪲"}
              </x-button>
              <x-button
                class="auth-button"
                size="small"
                @click="${this.handleAuthClick}"
              >
                Logout
              </x-button>
            </div>
          `
          : null}
      </div>
    `;
  }
}

globalThis.customElements.define("x-header-view", XHeaderView);

function getConnectionColor(connectionStatus: ConnectionStatus): string {
  const saturation = 65;
  const lightness = 50;

  const colorMap = {
    connecting: 60, // Yellow
    connected: 120, // Green
    conflict: 30, // Orange
    disconnected: 0, // Red
    error: 0, // Red
  };

  const hue = colorMap[connectionStatus] ?? 60; // Default to yellow
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}
