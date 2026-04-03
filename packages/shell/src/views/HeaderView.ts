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
import "../components/PieceList.ts";
import { type PieceItem } from "../components/PieceList.ts";
import {
  iconArrowLeft,
  iconBug,
  iconChevronDown,
  iconChevronRight,
  iconClose,
  iconFolder,
  iconLink,
  iconLogOut,
  iconStar,
} from "../components/icons.ts";

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

  /** Subscribe to the favorites list so the menu reflects current state. */
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

  /** Unsubscribe from favorites when component disconnects or runtime changes. */
  private _cleanupFavoritesSubscription(): void {
    if (this._unsubscribeFavorites) {
      this._unsubscribeFavorites();
      this._unsubscribeFavorites = undefined;
    }
  }

  /**
   * Derive whether the current piece is favorited. Prefers optimistic
   * local state (set immediately on click) over server state.
   */
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

  /**
   * Temporarily disable all CSS transitions during viewport resize to
   * prevent the menu from flashing when crossing the mobile/desktop
   * breakpoint in DevTools.
   */
  private _handleResize = () => {
    this.classList.add("resizing");
    if (this._resizeTimer) clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => {
      this.classList.remove("resizing");
    }, 150);
  };

  /** Close the innermost open dropdown on Escape, prioritizing the piece
   *  switcher over the main menu. Returns focus to the trigger on menu close. */
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
      this._piecesCache = undefined;
      this._setupFavoritesSubscription();
    }
    if (changedProperties.has("pieceId")) {
      this._localIsFavorite = undefined;
    }
  }

  /**
   * Eagerly fetch all pieces in the current space as soon as the
   * runtime is available. Results are cached until the runtime changes
   * (e.g. navigating to a different space). This ensures the piece list
   * is ready by the time the user opens a dropdown.
   * Fetches are parallelized with Promise.allSettled; pieces that fail
   * to resolve are silently skipped.
   */
  private _piecesCache: PieceItem[] | undefined;

  private _pieces = new Task(this, {
    task: async ([rt]): Promise<PieceItem[]> => {
      if (!rt) {
        this._piecesCache = undefined;
        return [];
      }
      if (this._piecesCache) return this._piecesCache;

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

      this._piecesCache = results
        .filter(
          (r): r is PromiseFulfilledResult<PieceItem> =>
            r.status === "fulfilled",
        )
        .map((r) => r.value);
      return this._piecesCache;
    },
    args: () => [this.rt] as const,
  });

  /** Clear the keystore and identity, logging the user out. */
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

  /** Toggle the debugger panel visibility via app state command. */
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

  /** Navigate to the current space root when the breadcrumb is clicked. */
  private _handleSpaceClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    if (this.spaceName) {
      navigate({ spaceName: this.spaceName });
    } else if (this.spaceDid) {
      navigate({ spaceDid: this.spaceDid });
    }
  }

  /** Open the main dropdown menu and move focus to the close button. */
  private handleLogoClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.menuOpen = true;
    this.updateComplete.then(() => {
      this.renderRoot.querySelector<HTMLElement>(".menu-close")?.focus();
    });
  }

  /** Return focus to the logo trigger button after the menu closes. */
  private _focusTrigger() {
    this.updateComplete.then(() => {
      this.renderRoot.querySelector<HTMLElement>(".nav-picker")?.focus();
    });
  }

  /** Close the main menu via the X button. */
  private handleCloseMenu(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.menuOpen = false;
    this.pieceListExpanded = false;
    this._focusTrigger();
  }

  /** Close the main menu when the dark backdrop overlay is clicked. */
  private handleBackdropClick() {
    this.menuOpen = false;
    this.pieceListExpanded = false;
    this._focusTrigger();
  }

  /** Toggle the piece list inside the mobile menu. */
  private handleTogglePieceList(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.pieceListExpanded = !this.pieceListExpanded;
  }

  /** Toggle the piece switcher dropdown in the desktop header breadcrumb. */
  private handleToggleHeaderPieceDropdown(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.headerPieceDropdownOpen = !this.headerPieceDropdownOpen;
  }

  /** Close the desktop piece switcher when clicking outside of it. */
  private _closeHeaderPieceDropdown = (e: Event) => {
    const path = e.composedPath();
    const wrapper = this.renderRoot.querySelector(".header-piece-wrapper");
    if (wrapper && !path.includes(wrapper)) {
      this.headerPieceDropdownOpen = false;
    }
  };

  /** Handle piece selection from either the mobile or desktop piece list. */
  private handlePieceSelected(e: Event) {
    const { id: pieceId } = (e as CustomEvent<PieceItem>).detail;
    this.menuOpen = false;
    this.pieceListExpanded = false;
    this.headerPieceDropdownOpen = false;
    if (this.spaceName) {
      navigate({ spaceName: this.spaceName, pieceId });
    } else if (this.spaceDid) {
      navigate({ spaceDid: this.spaceDid, pieceId });
    }
  }

  /**
   * Contextual navigation: when viewing a piece, go back to the space
   * root. When already at the space root, go to the user's home (/).
   */
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

  /** Whether we have a space identifier (name or DID) to navigate with. */
  private get _hasSpace(): boolean {
    return !!(this.spaceName || this.spaceDid);
  }

  /** Human-readable space name, falling back to a truncated DID. */
  private get _spaceDisplayName(): string {
    if (this.spaceName) return this.spaceName;
    if (this.spaceDid) return this.spaceDid.slice(0, 20) + "...";
    return "";
  }

  /** True when viewing a specific piece (not the space's default pattern). */
  private get _isViewingPiece(): boolean {
    return !!(this.pieceId && this._hasSpace && !this.isViewingDefaultPattern);
  }

  /** Label for the navigate-up button: "Back to <space>" or "Go Home". */
  private get _navigateUpLabel(): string {
    if (this._isViewingPiece) {
      return `Back to ${this._spaceDisplayName}`;
    }
    return "Go Home";
  }

  /** Copy the current page URL to the clipboard. */
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

  /**
   * Toggle the current piece's favorite status. Uses optimistic UI —
   * updates local state immediately, then syncs with the server.
   * Rolls back local state on error. Guarded against double-clicks
   * with _isFavoriteLoading to prevent conflicting requests.
   */
  private _isFavoriteLoading = false;

  private async handleToggleFavorite(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    if (!this.rt || !this.pieceId || this._isFavoriteLoading) return;

    const currentlyFavorite = this._isFavorite();
    this._localIsFavorite = !currentlyFavorite;
    this._isFavoriteLoading = true;

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
    } finally {
      this._isFavoriteLoading = false;
    }
  }

  /** Derive connection status from runtime availability. */
  private getConnectionStatus(): ConnectionStatus {
    return this.rt ? "connected" : "disconnected";
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
              <span class="chevron-down">${iconChevronDown()}</span>
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
                          ${iconChevronDown()}
                        </span>
                      </button>
                      ${this.headerPieceDropdownOpen
                        ? html`
                          <div class="header-piece-dropdown">
                            <x-piece-list
                              .pieces="${this._pieces.value ?? []}"
                              .activePieceId="${this.pieceId}"
                              @piece-selected="${this.handlePieceSelected}"
                            ></x-piece-list>
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
              <span class="menu-close-icon">${iconClose()}</span>
            </button>
            <div class="menu-title">
              ${this._hasSpace
                ? html`
                  <div class="breadcrumb">
                    <span class="breadcrumb-icon">${iconFolder()}</span>
                    <span class="breadcrumb-text">${this
                      ._spaceDisplayName}</span>
                    <span class="breadcrumb-chevron">
                      ${iconChevronRight()}
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
                  ${iconChevronDown()}
                </span>
              </button>
              ${this.pieceListExpanded
                ? html`
                  <x-piece-list
                    .pieces="${this._pieces.value ?? []}"
                    .activePieceId="${this.pieceId}"
                    @piece-selected="${this.handlePieceSelected}"
                  ></x-piece-list>
                `
                : nothing}
            </div>

            <div class="menu-rows">
              <button class="menu-item" role="menuitem" @click="${this
                .handleNavigateUp}">
                <span class="menu-item-icon">${iconArrowLeft()}</span>
                <span class="menu-item-label">${this._navigateUpLabel}</span>
              </button>

              <div class="divider"><div class="divider-line"></div></div>

              ${this.pieceId
                ? html`
                  <button class="menu-item" role="menuitem" @click="${this
                    .handleToggleFavorite}">
                    <span class="menu-item-icon">${iconStar(
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
                <span class="menu-item-icon">${iconLink()}</span>
                <span class="menu-item-label">Copy link</span>
              </button>

              <button class="menu-item" role="menuitem" @click="${this
                .handleDebuggerToggleClick}">
                <span class="menu-item-icon">${iconBug()}</span>
                <span class="menu-item-label">Toggle debug mode</span>
              </button>

              <div class="divider"><div class="divider-line"></div></div>

              <button class="menu-item" role="menuitem" @click="${this
                .handleAuthClick}">
                <span class="menu-item-icon">${iconLogOut()}</span>
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
