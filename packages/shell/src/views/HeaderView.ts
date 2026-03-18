import { css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { KeyStore } from "@commontools/identity";
import { BaseView } from "./BaseView.ts";
import { RuntimeInternals } from "../lib/runtime.ts";
import "../components/Flex.ts";
import "../components/Spinner.ts";

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
    }

    /* Header bar */
    .header {
      display: flex;
      align-items: center;
      padding: 24px;
      position: sticky;
      top: 0;
      z-index: 3;
      background-color: var(--header-bg-color, white);
    }

    .header-start {
      display: flex;
      flex: 1;
      align-items: center;
      gap: 8px;
    }

    /* Logo picker button */
    .nav-picker {
      display: flex;
      align-items: center;
      cursor: pointer;
      border: none;
      background: none;
      border-radius: 6px;
      padding: 0;
      overflow: hidden;
    }

    .nav-picker:hover {
      background: rgba(0, 0, 0, 0.04);
    }

    .nav-picker-container {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px;
      border-radius: 6px;
    }

    .nav-picker ct-logo {
      width: 24px;
      height: 24px;
    }

    .chevron-down {
      width: 12px;
      height: 12px;
      color: var(--gray-800, #2c3138);
    }

    /* Close button */
    .close-button {
      display: flex;
      align-items: center;
      cursor: pointer;
      border: none;
      background: none;
      border-radius: 6px;
      padding: 4px;
    }

    .close-button:hover {
      background: rgba(0, 0, 0, 0.04);
    }

    .close-icon {
      width: 24px;
      height: 24px;
      color: var(--gray-800, #2c3138);
    }

    /* Menu overlay - desktop: dropdown, mobile: full-width */
    .menu-container {
      position: fixed;
      inset: 0;
      z-index: 4;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease;
    }

    .menu-container.open {
      opacity: 1;
      pointer-events: auto;
    }

    .menu-backdrop {
      position: fixed;
      inset: 0;
    }

    .menu-panel {
      background: white;
      display: flex;
      flex-direction: column;
      box-shadow:
        0px 4px 16px 0px rgba(0, 0, 0, 0.08),
        0px 3px 8px 0px rgba(0, 0, 0, 0.04),
        0px 0px 3px 0px rgba(0, 0, 0, 0.12);
      z-index: 1;
      position: relative;
    }

    /* Desktop: positioned dropdown */
    @media (min-width: 769px) {
      .menu-backdrop {
        background: transparent;
      }

      .menu-panel {
        position: absolute;
        top: 0;
        left: 16px;
        width: 320px;
        padding: 16px;
        border-radius: 12px;
        transform: translateY(64px);
        opacity: 0;
        transition: opacity 0.15s ease;
        overflow: visible;
      }

      .menu-container.open .menu-panel {
        opacity: 1;
      }
    }

    /* Mobile: full-width slide-down */
    @media (max-width: 768px) {
      .menu-backdrop {
        background: rgba(13, 18, 24, 0.5);
      }

      .menu-panel {
        width: 100%;
        padding: 80px 24px 24px;
        border-radius: 16px;
        overflow: hidden;
        transform: translateY(-100%);
        transition: transform 0.25s ease;
      }

      .menu-container.open .menu-panel {
        transform: translateY(0);
      }
    }

    /* Menu title section */
    .menu-title {
      display: flex;
      flex-direction: column;
      padding-bottom: 12px;
    }

    .breadcrumb {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 6px;
    }

    .breadcrumb-icon {
      width: 12px;
      height: 12px;
      color: var(--gray-300, #8a909b);
      flex-shrink: 0;
    }

    .breadcrumb-text {
      font-family: "JetBrains Mono", monospace;
      font-weight: 500;
      font-size: 11px;
      line-height: 16px;
      color: var(--gray-300, #8a909b);
      letter-spacing: -0.22px;
      white-space: nowrap;
    }

    .breadcrumb-chevron {
      width: 12px;
      height: 12px;
      color: var(--gray-300, #8a909b);
      opacity: 0.5;
      flex-shrink: 0;
    }

    .piece-title-row {
      display: flex;
      align-items: center;
      gap: 0;
      padding: 8px 10px;
    }

    .piece-title-text {
      font-family: "JetBrains Mono", monospace;
      font-weight: 500;
      font-size: 16px;
      line-height: 16px;
      color: var(--gray-800, #2c3138);
      letter-spacing: -0.32px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .piece-title-chevron {
      width: 12px;
      height: 12px;
      color: var(--gray-800, #2c3138);
      flex-shrink: 0;
      margin-left: 2px;
    }

    /* Menu items */
    .menu-rows {
      display: flex;
      flex-direction: column;
    }

    .menu-item {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 16px;
      border-radius: 8px;
      cursor: pointer;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
    }

    .menu-item:hover {
      background: rgba(0, 0, 0, 0.03);
    }

    .menu-item-icon {
      width: 24px;
      height: 24px;
      flex-shrink: 0;
      color: var(--gray-800, #2c3138);
    }

    .menu-item-label {
      font-family: "PP Mori", sans-serif;
      font-weight: 600;
      font-size: 13px;
      line-height: 24px;
      color: var(--gray-800, #2c3138);
      letter-spacing: 0.3px;
      white-space: nowrap;
    }

    .divider {
      height: 16px;
      display: flex;
      align-items: center;
      width: 100%;
      padding: 0 16px;
      box-sizing: border-box;
    }

    .divider-line {
      height: 1px;
      width: 100%;
      background: var(--layer-2-divider, #e1e3e8);
    }

    /* Loading overlay */
    .loading-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(255, 255, 255, 0.7);
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .loading-overlay x-spinner {
      width: auto;
      height: auto;
      background: transparent;
    }

    @keyframes spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }

    .reload-icon {
      cursor: pointer;
      opacity: 0.5;
      transition: opacity 0.2s;
      user-select: none;
      font-size: 1.1rem;
      margin-left: 0.35rem;
    }

    .reload-icon:hover {
      opacity: 1;
    }

    .reload-icon.reloading {
      opacity: 0.7;
      animation: spin 1s linear infinite;
      pointer-events: none;
    }
  `;

  @property()
  private keyStore?: KeyStore;

  @property()
  private rt?: RuntimeInternals;

  @property({ attribute: false })
  pieceTitle?: string;

  @property({ attribute: false })
  pieceId?: string;

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

  @state()
  private isReloading = false;

  @state()
  private menuOpen = false;

  private handleAuthClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    if (!this.keyStore) {
      console.warn("Could not clear keystore.");
    } else {
      this.keyStore.clear().catch(console.error);
    }
    this.command({ type: "set-identity", identity: undefined });
    this.menuOpen = false;
  }

  private handleDebuggerToggleClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.command({
      type: "set-config",
      key: "showDebuggerView",
      value: !this.showDebuggerView,
    });
    this.menuOpen = false;
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
    if (!this.rt || this.isReloading) return;
    this.isReloading = true;
    try {
      await this.rt.recreateSpaceRootPattern();
      this.dispatchEvent(
        new CustomEvent("pattern-recreated", {
          bubbles: true,
          composed: true,
        }),
      );
    } catch (err) {
      console.error("[HeaderView] Failed to recreate pattern:", err);
    } finally {
      this.isReloading = false;
    }
  }

  private handleLogoClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.menuOpen = true;
  }

  private handleCloseMenu(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.menuOpen = false;
  }

  private handleBackdropClick() {
    this.menuOpen = false;
  }

  private handleGoToWorkspace(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.menuOpen = false;
    globalThis.location.href = "/";
  }

  private async handleCopyLink(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(globalThis.location.href);
    } catch {
      console.warn("Failed to copy link to clipboard");
    }
    this.menuOpen = false;
  }

  private async handleAddToFavorites(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    if (this.rt && this.pieceId) {
      try {
        await this.rt.favorites().addFavorite(
          this.pieceId,
          undefined,
          this.rt.spaceName(),
        );
      } catch (err) {
        console.error("[HeaderView] Error adding favorite:", err);
      }
    }
    this.menuOpen = false;
  }

  private getConnectionStatus(): ConnectionStatus {
    return this.rt ? "connected" : "disconnected";
  }

  // SVG icon templates
  private iconChevronDown() {
    return html`
      <svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M2.5 4L6 7.5L9.5 4" stroke="currentColor"
          stroke-width="1.5" stroke-linecap="round"
          stroke-linejoin="round"/>
      </svg>
    `;
  }

  private iconClose() {
    return html`
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M6 6L18 18M18 6L6 18" stroke="currentColor"
          stroke-width="2" stroke-linecap="round"
          stroke-linejoin="round"/>
      </svg>
    `;
  }

  private iconFolder() {
    return html`
      <svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M1.5 2.5V9.5C1.5 10.0523 1.94772 10.5 2.5 10.5H9.5C10.0523 10.5 10.5 10.0523 10.5 9.5V4.5C10.5 3.94772 10.0523 3.5 9.5 3.5H6L4.5 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5Z"
          stroke="currentColor" stroke-width="1" stroke-linecap="round"
          stroke-linejoin="round"/>
      </svg>
    `;
  }

  private iconChevronRight() {
    return html`
      <svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor"
          stroke-width="1.5" stroke-linecap="round"
          stroke-linejoin="round"/>
      </svg>
    `;
  }

  private iconArrowLeft() {
    return html`
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M19 12H5M5 12L12 19M5 12L12 5"
          stroke="currentColor" stroke-width="2" stroke-linecap="round"
          stroke-linejoin="round"/>
      </svg>
    `;
  }

  private iconStar() {
    return html`
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"
          stroke="currentColor" stroke-width="2" stroke-linecap="round"
          stroke-linejoin="round"/>
      </svg>
    `;
  }

  private iconLink() {
    return html`
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M10 13C10.4295 13.5741 10.9774 14.0491 11.6066 14.3929C12.2357 14.7367 12.9315 14.9411 13.6467 14.9923C14.3618 15.0435 15.0796 14.9403 15.7513 14.6897C16.4231 14.4392 17.0331 14.0471 17.54 13.54L20.54 10.54C21.4508 9.59695 21.9548 8.33394 21.9434 7.02296C21.932 5.71198 21.4061 4.45791 20.479 3.53087C19.552 2.60383 18.2979 2.07799 16.987 2.0666C15.676 2.0552 14.413 2.55918 13.47 3.47L11.75 5.18"
          stroke="currentColor" stroke-width="2" stroke-linecap="round"
          stroke-linejoin="round"/>
        <path d="M14 11C13.5705 10.4259 13.0226 9.95083 12.3934 9.60706C11.7642 9.26329 11.0685 9.05886 10.3533 9.00765C9.63819 8.95643 8.92037 9.05963 8.24861 9.3102C7.57685 9.56077 6.96684 9.95284 6.46 10.46L3.46 13.46C2.54918 14.403 2.0452 15.666 2.0566 16.977C2.068 18.288 2.59383 19.542 3.52087 20.4691C4.44791 21.3961 5.70198 21.922 7.01296 21.9334C8.32394 21.9448 9.58694 21.4408 10.53 20.53L12.24 18.82"
          stroke="currentColor" stroke-width="2" stroke-linecap="round"
          stroke-linejoin="round"/>
      </svg>
    `;
  }

  private iconBug() {
    return html`
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M8 2L6 4M16 2L18 4" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M3 12H6M18 12H21" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M3 18H6M18 18H21" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M12 20C9.79086 20 8 17.3137 8 14V10C8 7.79086 9.79086 6 12 6C14.2091 6 16 7.79086 16 10V14C16 17.3137 14.2091 20 12 20Z"
          stroke="currentColor" stroke-width="2" stroke-linecap="round"
          stroke-linejoin="round"/>
        <path d="M8 10H16" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
  }

  private iconLogOut() {
    return html`
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M9 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V5C3 4.46957 3.21071 3.96086 3.58579 3.58579C3.96086 3.21071 4.46957 3 5 3H9"
          stroke="currentColor" stroke-width="2" stroke-linecap="round"
          stroke-linejoin="round"/>
        <path d="M16 17L21 12L16 7" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M21 12H9" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
  }

  override render() {
    const connectionStatus = this.getConnectionStatus();
    const connectionColor = getConnectionColor(connectionStatus);

    const reloadIcon = this.isViewingDefaultPattern && this.isLoggedIn
      ? html`
        <span
          class="reload-icon ${this.isReloading ? "reloading" : ""}"
          @click="${this.handleReloadPatternClick}"
          title="Reload default pattern"
        >↻</span>
      `
      : nothing;

    const loadingOverlay = this.isReloading
      ? html`<div class="loading-overlay"><x-spinner></x-spinner></div>`
      : nothing;

    return html`
      <div class="header">
        <div class="header-start">
          ${
      this.menuOpen
        ? html`
              <button class="close-button" @click="${this.handleCloseMenu}">
                <span class="close-icon">${this.iconClose()}</span>
              </button>
            `
        : html`
              <button class="nav-picker" @click="${this.handleLogoClick}">
                <span class="nav-picker-container">
                  <ct-logo
                    .backgroundColor="${connectionColor}"
                    .width="${24}"
                    .height="${24}"
                  ></ct-logo>
                  <span class="chevron-down">${this.iconChevronDown()}</span>
                </span>
              </button>
              ${reloadIcon}
            `
    }
        </div>
      </div>

      <div class="menu-container ${this.menuOpen ? "open" : ""}">
        <div class="menu-backdrop"
          @click="${this.handleBackdropClick}"></div>
        <div class="menu-panel">
          <div class="menu-title">
            ${
      this.spaceName
        ? html`
                <div class="breadcrumb">
                  <span class="breadcrumb-icon">${this.iconFolder()}</span>
                  <span class="breadcrumb-text">${this.spaceName}</span>
                  <span class="breadcrumb-chevron">
                    ${this.iconChevronRight()}
                  </span>
                </div>
              `
        : nothing
    }
            <div class="piece-title-row">
              <span class="piece-title-text">
                ${this.pieceTitle || "Untitled"}
              </span>
              <span class="piece-title-chevron">
                ${this.iconChevronDown()}
              </span>
            </div>
          </div>

          <div class="menu-rows">
            <button class="menu-item"
              @click="${this.handleGoToWorkspace}">
              <span class="menu-item-icon">${this.iconArrowLeft()}</span>
              <span class="menu-item-label">Go to Workspace</span>
            </button>

            <div class="divider"><div class="divider-line"></div></div>

            ${
      this.pieceId
        ? html`
                <button class="menu-item"
                  @click="${this.handleAddToFavorites}">
                  <span class="menu-item-icon">${this.iconStar()}</span>
                  <span class="menu-item-label">Add to Favorites</span>
                </button>
              `
        : nothing
    }

            <button class="menu-item"
              @click="${this.handleCopyLink}">
              <span class="menu-item-icon">${this.iconLink()}</span>
              <span class="menu-item-label">Copy link</span>
            </button>

            <button class="menu-item"
              @click="${this.handleDebuggerToggleClick}">
              <span class="menu-item-icon">${this.iconBug()}</span>
              <span class="menu-item-label">Toggle debug mode</span>
            </button>

            <div class="divider"><div class="divider-line"></div></div>

            <button class="menu-item"
              @click="${this.handleAuthClick}">
              <span class="menu-item-icon">${this.iconLogOut()}</span>
              <span class="menu-item-label">Sign out</span>
            </button>
          </div>
        </div>
      </div>

      ${loadingOverlay}
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

  const hue = colorMap[connectionStatus] ?? 60;
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}
