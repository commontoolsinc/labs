import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { Identity, KeyStore } from "@commontools/identity";
import { BaseView } from "./BaseView.ts";
import { Task } from "@lit/task";
import { getNavigationHref } from "../lib/navigate.ts";
import { styleMap } from "lit/directives/style-map.js";
import { RuntimeInternals } from "../lib/runtime.ts";
import { InspectorConflicts, InspectorUpdateEvent } from "../lib/inspector.ts";

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

    .right-section {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .emoji-button {
      background: none;
      border: none;
      font-size: 1.25rem;
      cursor: pointer;
      padding: 0.25rem;
      opacity: 0.7;
      transition: opacity 0.2s;
      line-height: 1;
    }

    .emoji-button:hover {
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

    a, a:visited {
      color: var(--primary-font, "#000");
    }
  `;

  private _charm = new Task(this, {
    task: async ([charmId, rt]) => {
      if (!charmId || !rt) {
        return;
      }
      return await rt.cc().get(charmId!);
    },
    args: () => [this.charmId, this.rt],
  });

  @property()
  private keyStore?: KeyStore;

  @property()
  private rt?: RuntimeInternals;

  @property({ attribute: false })
  charmId?: string;

  @property({ attribute: false })
  spaceName?: string;

  @property({ attribute: false })
  identity?: Identity;

  @state()
  private _conflicts?: InspectorConflicts;

  @state()
  showCharmList = false;

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
    this.showCharmList = !this.showCharmList;
    this.dispatchEvent(
      new CustomEvent("toggle-view", {
        detail: { showCharmList: this.showCharmList },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private getConnectionStatus(): ConnectionStatus {
    if (this._conflicts) {
      return "conflict";
    }
    return this.rt ? "connected" : "disconnected";
  }

  #onInspectorUpdate = (e: Event) => {
    this._conflicts = (e as InspectorUpdateEvent).detail.model.getErrors();
  };

  override render() {
    const activeCharmName = this._charm.value
      ? this._charm.value.name()
      : undefined;
    const spaceLink = this.spaceName
      ? html`
        <a class="space-link" href="${getNavigationHref(this.spaceName)}">${this
          .spaceName}</a>
      `
      : null;
    const charmLink = activeCharmName && this.spaceName && this.charmId
      ? html`
        <a class="charm-link" href="${getNavigationHref(
          this.spaceName,
          this.charmId,
        )}">${activeCharmName}</a>
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
          <div class="right-section">
            <button
              class="emoji-button"
              @click="${this.handleToggleClick}"
              title="${this.showCharmList
            ? "Show Default Recipe"
            : "Show All Charms"}"
            >
              ${this.showCharmList ? "📋" : "🔍"}
            </button>
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
