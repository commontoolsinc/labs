import { css, html, LitElement } from "lit";
import { property, state } from "lit/decorators.js";
import { Identity } from "@commontools/identity";
import "./CTLogo.ts";

export class XHeaderElement extends LitElement {
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

  @property({ attribute: false })
  identity?: Identity;

  @state()
  private headerColor = "#f9fafb";

  @state()
  private logoShapeColor = "#000000";

  @state()
  private logoBackgroundColor = "#d2d2d2";

  private generateRandomColor(): string {
    const hue = Math.floor(Math.random() * 360);
    const saturation = Math.floor(Math.random() * 30) + 15;
    const lightness = Math.floor(Math.random() * 20) + 70;
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  }

  private generateLogoColor(): string {
    const hue = Math.floor(Math.random() * 360);
    const saturation = Math.floor(Math.random() * 30) + 50;
    const lightness = Math.floor(Math.random() * 20) + 40;
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  }

  private handleHeaderClick = (e: Event): void => {
    const target = e.target as HTMLElement;
    if (!target.closest("ct-logo")) {
      const newColor = this.generateRandomColor();
      this.headerColor = newColor;
      this.style.setProperty("--header-bg-color", newColor);

      this.logoBackgroundColor = this.generateLogoColor();
      this.logoShapeColor = newColor;
      this.requestUpdate();
    }
  };

  private handleLogoClick = (e: Event): void => {
    e.stopPropagation();
    this.logoBackgroundColor = this.generateLogoColor();
    this.logoShapeColor = this.headerColor;
    this.requestUpdate();
  };

  private handleAuthClick = (): void => {
    this.dispatchEvent(
      new CustomEvent("shell-command", {
        detail: { type: "clear-authentication" },
        bubbles: true,
        composed: true,
      }),
    );
  };

  override render() {
    return html`
      <div id="header" @click="${this.handleHeaderClick}">
        <div class="left-section">
          <ct-logo
            width="32"
            height="32"
            background-color="${this.logoBackgroundColor}"
            shape-color="${this.logoShapeColor}"
            @click="${this.handleLogoClick}"
          ></ct-logo>
          <h1 id="page-title">shell</h1>
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
