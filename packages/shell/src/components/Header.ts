import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { Identity } from "@commontools/identity";
import { BaseView } from "../views/BaseView.ts";
import { CharmsController } from "@commontools/charm/ops";
import { Task } from "@lit/task";
import { getNavigationHref } from "../lib/navigate.ts";

export class XHeaderElement extends BaseView {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: auto;
      background-color: var(--header-bg-color, #f9fafb);
      border-bottom: var(--border-width, 2px) solid var(--border-color, #000);
      transition: background-color 0.3s ease;
      cursor: pointer;
    }

    #header {
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

    .auth-button {
      padding: 0.25rem 0.75rem;
      font-family: var(--font-primary);
      font-size: 0.875rem;
      background-color: white;
      border: var(--border-width, 2px) solid var(--border-color, #000);
      cursor: pointer;
      transition: all 0.1s ease-in-out;
    }

    .auth-button:hover {
      transform: translateY(-1px);
      box-shadow: 1px 1px 0px 0px rgba(0, 0, 0, 0.5);
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

  private _charm = new Task(this, {
    task: async ([charmId, cc]) => {
      if (!this.charmId || !this.cc) {
        return;
      }
      return await cc!.get(charmId!);
    },
    args: () => [this.charmId, this.cc],
  });

  @property({ attribute: false })
  charmId?: string;

  @property({ attribute: false })
  spaceName?: string;

  @property({ attribute: false })
  cc?: CharmsController;

  @property({ attribute: false })
  identity?: Identity;

  @property({ attribute: false })
  connectionStatus:
    | "connecting"
    | "connected"
    | "disconnected"
    | "error"
    | "conflict" = "disconnected";

  @state()
  private headerColor = "#f9fafb";

  @state()
  private logoShapeColor = "#000000";

  @state()
  private logoBackgroundColor = "hsl(60, 65%, 50%)"; // Start with yellow (connecting)

  private getConnectionColor(): string {
    const saturation = 65;
    const lightness = 50;

    const colorMap = {
      connecting: 60, // Yellow
      connected: 120, // Green
      conflict: 30, // Orange
      disconnected: 0, // Red
      error: 0, // Red
    };

    const hue = colorMap[this.connectionStatus] ?? 60; // Default to yellow
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  }

  override connectedCallback() {
    super.connectedCallback();
    // Set initial color based on connection status
    this.logoBackgroundColor = this.getConnectionColor();
  }

  override updated(changedProperties: Map<string, any>) {
    super.updated(changedProperties);
    if (changedProperties.has("connectionStatus")) {
      const color = this.getConnectionColor();
      this.logoBackgroundColor = color;
      this.logoShapeColor = this.headerColor;
      this.requestUpdate();
    }
  }

  private generateRandomColor(): string {
    const hue = Math.floor(Math.random() * 360);
    const saturation = Math.floor(Math.random() * 30) + 15;
    const lightness = Math.floor(Math.random() * 20) + 70;
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  }

  private handleHeaderClick = (e: Event): void => {
    const target = e.target as HTMLElement;
    if (!target.closest("ct-logo")) {
      const newColor = this.generateRandomColor();
      this.headerColor = newColor;
      this.style.setProperty("--header-bg-color", newColor);
      this.logoShapeColor = newColor;
      this.requestUpdate();
    }
  };

  private handleAuthClick = async (): Promise<void> => {
    await this.command({ type: "clear-authentication" });
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

    return html`
      <div id="header" @click="${this.handleHeaderClick}">
        <div class="left-section">
          <ct-logo
            width="32"
            height="32"
            background-color="${this.logoBackgroundColor}"
            shape-color="${this.logoShapeColor}"
          ></ct-logo>
          ${title}
        </div>
        ${this.identity
        ? html`
          <button
            class="auth-button"
            @click="${this.handleAuthClick}"
            @mousedown="${(e: Event) => e.stopPropagation()}"
          >
            Logout
          </button>
        `
        : null}
      </div>
    `;
  }
}

globalThis.customElements.define("x-header", XHeaderElement);
