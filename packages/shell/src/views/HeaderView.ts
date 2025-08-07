import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { Identity, KeyStore } from "@commontools/identity";
import { BaseView } from "./BaseView.ts";
import { Task } from "@lit/task";
import { styleMap } from "lit/directives/style-map.js";
import { RuntimeInternals } from "../lib/runtime.ts";
import {
  StorageInspectorConflicts,
  StorageInspectorUpdateEvent,
} from "../lib/storage-inspector.ts";
import "../components/Flex.ts";
import { CharmController } from "@commontools/charm/ops";

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

    .button-group x-button {
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
  identity?: Identity;

  @state()
  private _conflicts?: StorageInspectorConflicts;

  @property()
  showShellCharmListView = false;

  @property()
  showInspectorView = false;

  private _inspectorListener = new Task(this, {
    args: () => [this.rt],
    task: ([rt]) => {
      if (this._inspectorListener.value) {
        this._inspectorListener.value.removeEventListener(
          "inspectorupdate",
          this.#onInspectorUpdate,
        );
      }
      if (rt) {
        rt.addEventListener("inspectorupdate", this.#onInspectorUpdate);
      }
      return rt;
    },
  });

  override connectedCallback() {
    super.connectedCallback();
    if (this._inspectorListener.value) {
      this._inspectorListener.value.addEventListener(
        "inspectorupdate",
        this.#onInspectorUpdate,
      );
    }
  }

  override disconnectedCallback() {
    if (this._inspectorListener.value) {
      this._inspectorListener.value.removeEventListener(
        "inspectorupdate",
        this.#onInspectorUpdate,
      );
    }
    super.disconnectedCallback();
  }

  @state()
  private headerColor = "#f9fafb";

  private handleHeaderClick = (e: Event): void => {
    const target = e.target as HTMLElement;
    if (target.closest("ct-logo")) {
      return;
    }
    this.headerColor = generateRandomColor();
  };

  private handleAuthClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    if (!this.keyStore) {
      console.warn("Could not clear keystore.");
    } else {
      this.keyStore.clear().catch(console.error);
    }
    this.command({ type: "clear-authentication" });
  }

  private handleToggleClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.command({
      type: "set-show-charm-list-view",
      show: !this.showShellCharmListView,
    });
  }

  private handleInspectorToggleClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.command({
      type: "set-show-inspector-view",
      show: !this.showInspectorView,
    });
  }

  private getConnectionStatus(): ConnectionStatus {
    if (this._conflicts) {
      return "conflict";
    }
    return this.rt ? "connected" : "disconnected";
  }

  #onInspectorUpdate = (e: Event) => {
    this._conflicts = (e as StorageInspectorUpdateEvent).detail.model
      .getErrors();
  };

  override render() {
    const spaceLink = this.spaceName
      ? html`
        <x-charm-link .spaceName="${this.spaceName}">${this
          .spaceName}</x-charm-link>
      `
      : null;
    const charmLink = this.charmId && this.spaceName
      ? html`
        <x-charm-link
          .charmId="${this.charmId}"
          .spaceName="${this.spaceName}"
        >${this.charmTitle || this.charmId}</x-charm-link>
      `
      : null;
    const title = html`
      <h1 id="page-title">
        ${spaceLink} ${charmLink ? "/" : ""} ${charmLink}
      </h1>
    `;

    const connectionStatus = this.getConnectionStatus();
    const connectionColor = getConnectionColor(connectionStatus);
    const styles = { "--header-bg-color": this.headerColor };

    return html`
      <div id="header" style="${styleMap(styles)}" @click="${this
        .handleHeaderClick}">
        <div class="left-section">
          <ct-logo
            .backgroundColor="${connectionColor}"
            .shapeColor="${this.headerColor}"
          ></ct-logo>
          ${title}
        </div>
        ${this.identity
        ? html`
          <div class="button-group">
            <x-button
              class="emoji-button"
              size="small"
              @click="${this.handleToggleClick}"
              title="${this.showShellCharmListView
            ? "Show Default Recipe"
            : "Show All Charms"}"
            >
              ${this.showShellCharmListView ? "📋" : "🔍"}
            </x-button>
            <x-button
              class="emoji-button"
              size="small"
              @click="${this.handleInspectorToggleClick}"
              title="${this.showInspectorView
            ? "Hide Inspector"
            : "Show Inspector"}"
            >
              ${this.showInspectorView ? "🔧" : "🛠️"}
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

function generateRandomColor(): string {
  const hue = Math.floor(Math.random() * 360);
  const saturation = Math.floor(Math.random() * 30) + 15;
  const lightness = Math.floor(Math.random() * 20) + 70;
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}
