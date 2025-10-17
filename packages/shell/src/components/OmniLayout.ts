import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";

export class XOmniLayout extends LitElement {
  static override styles = css`
    :host {
      display: grid;
      grid-template-columns: 1fr 0;
      grid-template-rows: 1fr;
      height: 100%;
      width: 100%;
      overflow: hidden;
    }

    .main {
      grid-column: 1;
      grid-row: 1;
      position: relative;
      overflow: auto;
    }

    .sidebar-container {
      grid-column: 2;
      grid-row: 1;
      position: relative;
      overflow: visible;
      width: 0;
    }

    .sidebar {
      position: absolute;
      top: 0;
      right: 0;
      height: 100%;
      width: 320px;
      background-color: var(--ct-theme-color-surface, #f1f5f9);
      border-left: 2px solid var(--ct-theme-color-border, #e5e7eb);
      transform: translateX(0);
      transition: transform 0.3s ease;
      overflow: auto;
    }

    .sidebar.closed {
      transform: translateX(calc(100% - 48px));
    }

    .sidebar-content {
      position: relative;
      height: 100%;
      width: 100%;
      padding: 48px 16px 16px 16px;
    }

    .toggle-button {
      position: absolute;
      top: 8px;
      left: 8px;
      background-color: var(--ct-theme-color-background, #ffffff);
      border: 2px solid var(--ct-theme-color-border, #e5e7eb);
      border-radius: 4px;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 16px;
      z-index: 10;
      transition: all 0.2s ease;
    }

    .toggle-button:hover {
      background-color: var(--ct-theme-color-surface-hover, #e2e8f0);
      transform: scale(1.05);
    }

    .toggle-button:active {
      transform: scale(0.95);
    }

    .fab {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 1000;
    }
  `;

  @property({ type: Boolean })
  sidebarOpen = true;

  private toggleSidebar() {
    this.sidebarOpen = !this.sidebarOpen;
  }

  override render() {
    return html`
      <div class="main">
        <slot name="main"></slot>
      </div>
      <div class="sidebar-container">
        <div class="sidebar ${this.sidebarOpen ? "" : "closed"}">
          <div class="sidebar-content">
            <button
              class="toggle-button"
              @click="${this.toggleSidebar}"
              title="${this.sidebarOpen ? "Close sidebar" : "Open sidebar"}"
            >
              ${this.sidebarOpen ? "✕" : "☰"}
            </button>
            <slot name="sidebar"></slot>
          </div>
        </div>
      </div>
      <div class="fab">
        <slot name="fab"></slot>
      </div>
    `;
  }
}

globalThis.customElements.define("x-omni-layout", XOmniLayout);
