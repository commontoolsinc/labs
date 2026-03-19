import { css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { type DID, KeyStore } from "@commontools/identity";
import { BaseView } from "./BaseView.ts";
import { RuntimeInternals } from "../lib/runtime.ts";
import { navigate } from "../../shared/mod.ts";
import { Task } from "@lit/task";
import { type CellHandle } from "@commontools/runtime-client";
import type { FavoriteEntry } from "@commontools/home-schemas";
import "../components/Flex.ts";

interface PieceItem {
  id: string;
  name: string;
}

type ConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error"
  | "conflict";

export class XHeaderView extends BaseView {
  static override styles = css`
    :host {
      box-sizing: border-box;
      display: block;
      width: 100%;
      height: auto;
      color: var(--gray-800, #2c3138);
    }

    *, *::before, *::after {
      box-sizing: inherit;
    }

    button {
      font-family: inherit;
    }

    svg {
      width: 100%;
      height: 100%;
    }

    /* Header bar */
    .header {
      display: flex;
      align-items: center;
      padding: 1.5rem;
      position: sticky;
      top: 0;
      z-index: 3;
      background-color: var(--header-bg-color, white);
    }

    .header-start {
      display: flex;
      flex: 1;
      align-items: center;
      gap: 0.5rem;
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
      gap: 0.25rem;
      padding: 0.25rem;
      border-radius: 6px;
    }

    .nav-picker ct-logo {
      width: 1.5rem;
      height: 1.5rem;
    }

    .chevron-down {
      width: 0.75rem;
      height: 0.75rem;
    }

    /* Header breadcrumbs (desktop only) */
    .header-breadcrumbs {
      display: none;
      align-items: center;
      gap: 0.375rem;
      min-width: 0;
    }

    @media (min-width: 769px) {
      .header-breadcrumbs {
        display: flex;
      }
    }

    .header-breadcrumbs .header-space {
      font-weight: 500;
      font-size: 0.75rem;
      line-height: 1rem;
      color: var(--gray-300, #8a909b);
      white-space: nowrap;
      cursor: pointer;
      text-decoration: none;
    }

    .header-breadcrumbs .header-space:hover {
      color: inherit;
    }

    .header-breadcrumbs .header-separator {
      color: var(--gray-300, #8a909b);
      font-size: 0.75rem;
    }

    .header-piece-wrapper {
      position: relative;
    }

    .header-piece-trigger {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      cursor: pointer;
      border: none;
      background: none;
      padding: 0.25rem 0.375rem;
      border-radius: 6px;
      font-weight: 500;
      font-size: 0.8125rem;
      line-height: 1rem;
      font-family: inherit;
    }

    .header-piece-trigger:hover {
      background: rgba(0, 0, 0, 0.04);
    }

    .header-piece-chevron {
      width: 0.625rem;
      height: 0.625rem;
      color: var(--gray-300, #8a909b);
      display: flex;
      align-items: center;
      transition: transform 0.15s ease;
    }

    .header-piece-chevron.expanded {
      transform: rotate(180deg);
    }

    .header-piece-dropdown {
      position: absolute;
      top: 100%;
      left: 0;
      margin-top: 0.25rem;
      min-width: 15rem;
      max-width: 20rem;
      background: white;
      border-radius: 8px;
      box-shadow:
        0px 4px 16px 0px rgba(0, 0, 0, 0.08),
        0px 3px 8px 0px rgba(0, 0, 0, 0.04),
        0px 0px 3px 0px rgba(0, 0, 0, 0.12);
      padding: 0.5rem;
      z-index: 10;
      max-height: 20rem;
      overflow-y: auto;
    }

    /* Menu overlay - desktop: dropdown, mobile: full-width */
    .menu-container {
      position: fixed;
      inset: 0;
      z-index: 4;
      pointer-events: none;
    }

    .menu-container.open {
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

    :host(.resizing) *,
    :host(.resizing) *::before,
    :host(.resizing) *::after {
      transition: none !important;
    }

    /* Desktop: positioned dropdown */
    @media (min-width: 769px) {
      .menu-backdrop {
        background: transparent;
      }

      .menu-panel {
        position: absolute;
        top: 0;
        left: 1rem;
        width: 20rem;
        padding: 1rem;
        border-radius: 12px;
        transform: translateY(4rem);
        opacity: 0;
        transition: opacity 0.15s ease;
        overflow: visible;
      }

      .menu-container.open .menu-panel {
        opacity: 1;
      }
    }

    /* Mobile: clip-path reveal */
    @media (max-width: 768px) {
      .menu-backdrop {
        background: rgba(13, 18, 24, 0.5);
        opacity: 0;
        transition: opacity 0.25s ease;
      }

      .menu-container.open .menu-backdrop {
        opacity: 1;
      }

      .menu-panel {
        width: 100%;
        padding: 1.5rem;
        border-radius: 0 0 16px 16px;
        overflow: hidden;
        clip-path: inset(0 0 100% 0);
        transition: clip-path 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      }

      .menu-container.open .menu-panel {
        clip-path: inset(0 0 0 0);
      }

      .menu-panel .menu-inner {
        opacity: 0;
        transition: opacity 0.15s ease;
      }

      .menu-container.open .menu-panel .menu-inner {
        opacity: 1;
        transition: opacity 0.2s ease 0.1s;
      }
    }

    .menu-close {
      display: flex;
      align-items: center;
      cursor: pointer;
      border: none;
      background: none;
      border-radius: 6px;
      padding: 0.25rem;
      align-self: flex-start;
      margin-bottom: 1.5rem;
    }

    @media (min-width: 769px) {
      .menu-close {
        margin-bottom: 0.5rem;
      }
    }

    .menu-close:hover {
      background: rgba(0, 0, 0, 0.04);
    }

    .menu-close-icon {
      width: 1.5rem;
      height: 1.5rem;
    }

    /* Menu title section */
    .menu-title {
      display: flex;
      flex-direction: column;
      padding-bottom: 0.75rem;
    }

    @media (min-width: 769px) {
      .menu-title {
        display: none;
      }
    }

    .breadcrumb {
      display: flex;
      align-items: center;
      padding: 0.25rem 1rem;
    }

    .breadcrumb-icon {
      width: 0.75rem;
      height: 0.75rem;
      color: var(--gray-300, #8a909b);
      flex-shrink: 0;
      display: flex;
      align-items: center;
    }

    .breadcrumb-text {
      font-weight: 500;
      font-size: 0.6875rem;
      line-height: 1rem;
      color: var(--gray-300, #8a909b);
      letter-spacing: -0.22px;
      white-space: nowrap;
      margin-left: 0.375rem;
    }

    .breadcrumb-chevron {
      width: 0.75rem;
      height: 0.75rem;
      color: var(--gray-300, #8a909b);
      opacity: 0.5;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      margin-left: 0.5rem;
    }

    .piece-title-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 1rem;
      cursor: pointer;
      border-radius: 6px;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
    }

    .piece-title-row:hover {
      background: rgba(0, 0, 0, 0.03);
    }

    .piece-title-text {
      font-weight: 500;
      font-size: 1rem;
      line-height: 1.5rem;

      letter-spacing: -0.32px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .piece-title-chevron {
      width: 0.75rem;
      height: 0.75rem;

      flex-shrink: 0;
      margin-left: 0.125rem;
      display: flex;
      align-items: center;
      transition: transform 0.15s ease;
    }

    .piece-title-chevron.expanded {
      transform: rotate(180deg);
    }

    /* Piece list */
    .piece-list {
      display: flex;
      flex-direction: column;
      padding: 0.25rem 0;
      margin-left: 1rem;
      max-height: 15rem;
      overflow-y: auto;
    }

    .piece-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.375rem 1rem;
      border: none;
      border-radius: 6px;
      background: none;
      cursor: pointer;
      font-weight: 400;
      font-size: 0.8125rem;
      line-height: 1.25rem;
      color: var(--gray-300, #8a909b);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-align: left;
      width: 100%;
      flex-shrink: 0;
    }

    .piece-item:hover {
      background: rgba(0, 0, 0, 0.03);
      color: inherit;
    }

    .piece-item.active {
      color: inherit;
    }

    .piece-item.active::before {
      content: "";
      width: 0.375rem;
      height: 0.375rem;
      border-radius: 50%;
      background: var(--accent-blue, #4979fa);
      flex-shrink: 0;
    }

    /* Menu items */
    .menu-rows {
      display: flex;
      flex-direction: column;
    }

    .menu-item {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 1rem;
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
      width: 1.5rem;
      height: 1.5rem;
      flex-shrink: 0;
    }

    .menu-item-label {
      font-weight: 600;
      font-size: 0.8125rem;
      line-height: 1.5rem;

      letter-spacing: 0.3px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }

    .divider {
      height: 1rem;
      display: flex;
      align-items: center;
      width: 100%;
      padding: 0 1rem;
      box-sizing: border-box;
    }

    .divider-line {
      height: 1px;
      width: 100%;
      background: var(--layer-2-divider, #e1e3e8);
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
  spaceDid?: DID;

  @property({ attribute: false })
  isLoggedIn = false;

  @property()
  showDebuggerView = false;

  @property({ attribute: false })
  isViewingDefaultPattern = false;

  @state()
  private menuOpen = false;

  @state()
  private pieceListExpanded = false;

  @state()
  private headerPieceDropdownOpen = false;

  @state()
  private _serverFavorites: readonly FavoriteEntry[] = [];

  @state()
  private _localIsFavorite: boolean | undefined = undefined;

  private _unsubscribeFavorites: (() => void) | undefined;

  private _setupFavoritesSubscription(): void {
    this._cleanupFavoritesSubscription();
    if (!this.rt) return;
    this._unsubscribeFavorites = this.rt.favorites().subscribeFavorites(
      (favorites) => {
        this._serverFavorites = favorites;
        this._localIsFavorite = undefined;
        this.requestUpdate();
      },
    );
  }

  private _cleanupFavoritesSubscription(): void {
    if (this._unsubscribeFavorites) {
      this._unsubscribeFavorites();
      this._unsubscribeFavorites = undefined;
    }
  }

  private _isFavorite(): boolean {
    if (this._localIsFavorite !== undefined) {
      return this._localIsFavorite;
    }
    if (!this.pieceId) return false;
    return this._serverFavorites.some(
      (f) => (f.cell as unknown as CellHandle<unknown>).id() === this.pieceId,
    );
  }

  private _resizeTimer?: ReturnType<typeof setTimeout>;

  override connectedCallback(): void {
    super.connectedCallback();
    this._setupFavoritesSubscription();
    this.addEventListener("keydown", this._handleKeyDown);
    globalThis.addEventListener("resize", this._handleResize);
    globalThis.addEventListener("click", this._closeHeaderPieceDropdown);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._cleanupFavoritesSubscription();
    this.removeEventListener("keydown", this._handleKeyDown);
    globalThis.removeEventListener("resize", this._handleResize);
    globalThis.removeEventListener("click", this._closeHeaderPieceDropdown);
    if (this._resizeTimer) clearTimeout(this._resizeTimer);
  }

  private _handleResize = () => {
    this.classList.add("resizing");
    if (this._resizeTimer) clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => {
      this.classList.remove("resizing");
    }, 150);
  };

  private _handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (this.headerPieceDropdownOpen) {
        e.preventDefault();
        this.headerPieceDropdownOpen = false;
        return;
      }
      if (this.menuOpen) {
        e.preventDefault();
        this.menuOpen = false;
        this.pieceListExpanded = false;
        this._focusTrigger();
      }
    }
  };

  protected override willUpdate(changedProperties: PropertyValues): void {
    if (changedProperties.has("rt")) {
      this._serverFavorites = [];
      this._localIsFavorite = undefined;
      this._setupFavoritesSubscription();
    }
    if (changedProperties.has("pieceId")) {
      this._localIsFavorite = undefined;
    }
  }

  private _pieces = new Task(this, {
    task: async ([rt, expanded]): Promise<PieceItem[]> => {
      if (!rt || !expanded) return [];
      await rt.synced();
      const piecesListCell = await rt.getPiecesListCell();
      await piecesListCell.sync();
      const piecesList = piecesListCell.get() as any[];
      if (!piecesList) return [];

      const ids: string[] = [];
      for (const pieceData of piecesList) {
        const id = pieceData?.id?.() ?? pieceData?.$ID;
        if (id) ids.push(id);
      }

      const results = await Promise.allSettled(
        ids.map(async (id) => {
          const page = await rt.getPattern(id);
          await page.cell().sync();
          return {
            id: page.id(),
            name: page.name() ?? `Piece #${page.id().slice(0, 6)}`,
          };
        }),
      );

      return results
        .filter(
          (r): r is PromiseFulfilledResult<PieceItem> =>
            r.status === "fulfilled",
        )
        .map((r) => r.value);
    },
    args: () =>
      [
        this.rt,
        this.pieceListExpanded || this.headerPieceDropdownOpen,
      ] as const,
  });

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

  private _handleSpaceClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    if (this.spaceName) {
      navigate({ spaceName: this.spaceName });
    } else if (this.spaceDid) {
      navigate({ spaceDid: this.spaceDid });
    }
  }

  private handleLogoClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.menuOpen = true;
    this.updateComplete.then(() => {
      this.renderRoot.querySelector<HTMLElement>(".menu-close")?.focus();
    });
  }

  private _focusTrigger() {
    this.updateComplete.then(() => {
      this.renderRoot.querySelector<HTMLElement>(".nav-picker")?.focus();
    });
  }

  private handleCloseMenu(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.menuOpen = false;
    this.pieceListExpanded = false;
    this._focusTrigger();
  }

  private handleBackdropClick() {
    this.menuOpen = false;
    this.pieceListExpanded = false;
    this._focusTrigger();
  }

  private handleTogglePieceList(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.pieceListExpanded = !this.pieceListExpanded;
  }

  private handleToggleHeaderPieceDropdown(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.headerPieceDropdownOpen = !this.headerPieceDropdownOpen;
  }

  private _closeHeaderPieceDropdown = (e: Event) => {
    const path = e.composedPath();
    const wrapper = this.renderRoot.querySelector(".header-piece-wrapper");
    if (wrapper && !path.includes(wrapper)) {
      this.headerPieceDropdownOpen = false;
    }
  };

  private handlePieceClick(e: Event) {
    const target = (e.target as HTMLElement).closest<HTMLElement>(
      "[data-piece-id]",
    );
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    const pieceId = target.dataset.pieceId!;
    this.menuOpen = false;
    this.pieceListExpanded = false;
    this.headerPieceDropdownOpen = false;
    if (this.spaceName) {
      navigate({ spaceName: this.spaceName, pieceId });
    } else if (this.spaceDid) {
      navigate({ spaceDid: this.spaceDid, pieceId });
    }
  }

  private handleNavigateUp(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.menuOpen = false;
    if (this._isViewingPiece) {
      // Viewing a piece — go back to the space
      if (this.spaceName) {
        navigate({ spaceName: this.spaceName });
      } else if (this.spaceDid) {
        navigate({ spaceDid: this.spaceDid });
      }
    } else {
      // At space root — go home
      globalThis.location.href = "/";
    }
  }

  private get _hasSpace(): boolean {
    return !!(this.spaceName || this.spaceDid);
  }

  private get _spaceDisplayName(): string {
    if (this.spaceName) return this.spaceName;
    if (this.spaceDid) return this.spaceDid.slice(0, 20) + "...";
    return "";
  }

  private get _isViewingPiece(): boolean {
    return !!(this.pieceId && this._hasSpace && !this.isViewingDefaultPattern);
  }

  private get _navigateUpLabel(): string {
    if (this._isViewingPiece) {
      return `Back to ${this._spaceDisplayName}`;
    }
    return "Go Home";
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

  private async handleToggleFavorite(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    if (!this.rt || !this.pieceId) return;

    const currentlyFavorite = this._isFavorite();
    this._localIsFavorite = !currentlyFavorite;

    try {
      if (currentlyFavorite) {
        await this.rt.favorites().removeFavorite(this.pieceId);
      } else {
        await this.rt.favorites().addFavorite(
          this.pieceId,
          undefined,
          this.rt.spaceName(),
        );
      }
    } catch (err) {
      console.error("[HeaderView] Error toggling favorite:", err);
      this._localIsFavorite = undefined;
    }
  }

  private getConnectionStatus(): ConnectionStatus {
    return this.rt ? "connected" : "disconnected";
  }

  // SVG icon templates
  private iconChevronDown() {
    return html`
      <svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M2.5 4L6 7.5L9.5 4"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    `;
  }

  private iconClose() {
    return html`
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M6 6L18 18M18 6L6 18"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    `;
  }

  private iconFolder() {
    return html`
      <svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M1.5 2.5V9.5C1.5 10.0523 1.94772 10.5 2.5 10.5H9.5C10.0523 10.5 10.5 10.0523 10.5 9.5V4.5C10.5 3.94772 10.0523 3.5 9.5 3.5H6L4.5 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5Z"
          stroke="currentColor"
          stroke-width="1"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    `;
  }

  private iconChevronRight() {
    return html`
      <svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M4.5 2.5L8 6L4.5 9.5"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    `;
  }

  private iconArrowLeft() {
    return html`
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M19 12H5M5 12L12 19M5 12L12 5"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    `;
  }

  private iconStar(filled = false) {
    return html`
      <svg viewBox="0 0 24 24" fill="${filled
        ? "currentColor"
        : "none"}" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    `;
  }

  private iconLink() {
    return html`
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M10 13C10.4295 13.5741 10.9774 14.0491 11.6066 14.3929C12.2357 14.7367 12.9315 14.9411 13.6467 14.9923C14.3618 15.0435 15.0796 14.9403 15.7513 14.6897C16.4231 14.4392 17.0331 14.0471 17.54 13.54L20.54 10.54C21.4508 9.59695 21.9548 8.33394 21.9434 7.02296C21.932 5.71198 21.4061 4.45791 20.479 3.53087C19.552 2.60383 18.2979 2.07799 16.987 2.0666C15.676 2.0552 14.413 2.55918 13.47 3.47L11.75 5.18"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M14 11C13.5705 10.4259 13.0226 9.95083 12.3934 9.60706C11.7642 9.26329 11.0685 9.05886 10.3533 9.00765C9.63819 8.95643 8.92037 9.05963 8.24861 9.3102C7.57685 9.56077 6.96684 9.95284 6.46 10.46L3.46 13.46C2.54918 14.403 2.0452 15.666 2.0566 16.977C2.068 18.288 2.59383 19.542 3.52087 20.4691C4.44791 21.3961 5.70198 21.922 7.01296 21.9334C8.32394 21.9448 9.58694 21.4408 10.53 20.53L12.24 18.82"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    `;
  }

  private iconBug() {
    return html`
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M8 2L6 4M16 2L18 4"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M3 12H6M18 12H21"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M3 18H6M18 18H21"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M12 20C9.79086 20 8 17.3137 8 14V10C8 7.79086 9.79086 6 12 6C14.2091 6 16 7.79086 16 10V14C16 17.3137 14.2091 20 12 20Z"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M8 10H16"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    `;
  }

  private iconLogOut() {
    return html`
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M9 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V5C3 4.46957 3.21071 3.96086 3.58579 3.58579C3.96086 3.21071 4.46957 3 5 3H9"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M16 17L21 12L16 7"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M21 12H9"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    `;
  }

  private renderPieceList() {
    const pieces = this._pieces.value ?? [];
    if (pieces.length === 0) {
      return html`
        <div class="piece-list">
          <span class="breadcrumb-text">No pieces found</span>
        </div>
      `;
    }
    return html`
      <div class="piece-list" @click="${this.handlePieceClick}">
        ${pieces.map((piece) =>
          html`
            <button
              class="piece-item ${piece.id === this.pieceId ? "active" : ""}"
              data-piece-id="${piece.id}"
            >
              ${piece.name}
            </button>
          `
        )}
      </div>
    `;
  }

  override render() {
    const connectionStatus = this.getConnectionStatus();
    const connectionColor = getConnectionColor(connectionStatus);
    const isFavorite = this._isFavorite();

    return html`
      <div class="header">
        <div class="header-start">
          <button
            class="nav-picker"
            @click="${this.handleLogoClick}"
            aria-haspopup="true"
            aria-expanded="${this.menuOpen}"
            aria-label="Open menu"
          >
            <span class="nav-picker-container">
              <ct-logo
                .backgroundColor="${connectionColor}"
                .width="${24}"
                .height="${24}"
              ></ct-logo>
              <span class="chevron-down">${this.iconChevronDown()}</span>
            </span>
          </button>
          <div class="header-breadcrumbs">
            ${this._hasSpace
              ? html`
                <a class="header-space" href="${this.spaceName
                  ? `/${this.spaceName}`
                  : `/${this.spaceDid ?? ""}`}" @click="${this
                  ._handleSpaceClick}">${this._spaceDisplayName}</a>
                ${this.pieceTitle
                  ? html`
                    <span class="header-separator">/</span>
                    <span class="header-piece-wrapper">
                      <button
                        class="header-piece-trigger"
                        @click="${this.handleToggleHeaderPieceDropdown}"
                        aria-haspopup="true"
                        aria-expanded="${this.headerPieceDropdownOpen}"
                      >
                        ${this.pieceTitle}
                        <span class="header-piece-chevron ${this
                            .headerPieceDropdownOpen
                          ? "expanded"
                          : ""}">
                          ${this.iconChevronDown()}
                        </span>
                      </button>
                      ${this.headerPieceDropdownOpen
                        ? html`
                          <div class="header-piece-dropdown">
                            ${this.renderPieceList()}
                          </div>
                        `
                        : nothing}
                    </span>
                  `
                  : nothing}
              `
              : nothing}
          </div>
        </div>
      </div>

      <div class="menu-container ${this.menuOpen ? "open" : ""}">
        <div class="menu-backdrop" @click="${this.handleBackdropClick}"></div>
        <div class="menu-panel" role="menu">
          <div class="menu-inner">
            <button class="menu-close" @click="${this
              .handleCloseMenu}" aria-label="Close menu">
              <span class="menu-close-icon">${this.iconClose()}</span>
            </button>
            <div class="menu-title">
              ${this._hasSpace
                ? html`
                  <div class="breadcrumb">
                    <span class="breadcrumb-icon">${this.iconFolder()}</span>
                    <span class="breadcrumb-text">${this
                      ._spaceDisplayName}</span>
                    <span class="breadcrumb-chevron">
                      ${this.iconChevronRight()}
                    </span>
                  </div>
                `
                : nothing}
              <button
                class="piece-title-row"
                @click="${this.handleTogglePieceList}"
                aria-expanded="${this.pieceListExpanded}"
              >
                <span class="piece-title-text">
                  ${this.pieceTitle || "Untitled"}
                </span>
                <span class="piece-title-chevron ${this.pieceListExpanded
                  ? "expanded"
                  : ""}">
                  ${this.iconChevronDown()}
                </span>
              </button>
              ${this.pieceListExpanded ? this.renderPieceList() : nothing}
            </div>

            <div class="menu-rows">
              <button class="menu-item" role="menuitem" @click="${this
                .handleNavigateUp}">
                <span class="menu-item-icon">${this.iconArrowLeft()}</span>
                <span class="menu-item-label">${this._navigateUpLabel}</span>
              </button>

              <div class="divider"><div class="divider-line"></div></div>

              ${this.pieceId
                ? html`
                  <button class="menu-item" role="menuitem" @click="${this
                    .handleToggleFavorite}">
                    <span class="menu-item-icon">${this.iconStar(
                      isFavorite,
                    )}</span>
                    <span class="menu-item-label">${isFavorite
                      ? "Remove from Favorites"
                      : "Add to Favorites"}</span>
                  </button>
                `
                : nothing}

              <button class="menu-item" role="menuitem" @click="${this
                .handleCopyLink}">
                <span class="menu-item-icon">${this.iconLink()}</span>
                <span class="menu-item-label">Copy link</span>
              </button>

              <button class="menu-item" role="menuitem" @click="${this
                .handleDebuggerToggleClick}">
                <span class="menu-item-icon">${this.iconBug()}</span>
                <span class="menu-item-label">Toggle debug mode</span>
              </button>

              <div class="divider"><div class="divider-line"></div></div>

              <button class="menu-item" role="menuitem" @click="${this
                .handleAuthClick}">
                <span class="menu-item-icon">${this.iconLogOut()}</span>
                <span class="menu-item-label">Sign out</span>
              </button>
            </div>
          </div>
        </div>
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

  const hue = colorMap[connectionStatus] ?? 60;
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}
