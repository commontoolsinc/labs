import { css, html, nothing, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import type { CellHandle, PieceSourceView } from "@commonfabric/runtime-client";
import {
  describeOrigin,
  formatTimestamp,
  shortIdentity,
} from "./origin-view.ts";

/** Which panel is showing, if any. */
export type Panel = "source" | "origin";

/** One entry in the menu, and the panel it opens. */
interface MenuEntry {
  label: string;
  /** Stable hook for tests, exposed as the entry's `test-id`. */
  testId: string;
  panel: Panel;
}

const ENTRIES: readonly MenuEntry[] = [
  { label: "View source", testId: "piece-menu-source", panel: "source" },
  {
    label: "Origin and history",
    testId: "piece-menu-origin",
    panel: "origin",
  },
];

/** The entries every piece menu shows, in order. */
export function pieceMenuEntries(): readonly MenuEntry[] {
  return ENTRIES;
}

/**
 * CFPieceMenu — the menu a right-click on a piece opens, with the panels for
 * the two things it can show about that piece: its authored source, and the
 * origin and history it records.
 *
 * @element cf-piece-menu
 *
 * Mounted on `document.body` by {@link openPieceMenu}, never inside the piece
 * it describes: a piece's own `overflow: hidden` would clip it, and the tile
 * variant's `transform: scale(0.5)` would both contain and shrink a
 * `position: fixed` overlay rendered in that subtree.
 *
 * A host that wants a different menu for a piece cancels the
 * `cf-piece-context-menu` announcement and shows its own; see
 * `docs/development/HOST_EMBEDDING.md`.
 */
export class CFPieceMenu extends BaseElement {
  static override styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 2147483000;
      display: block;
      font-family: var(--cf-theme-font-family, system-ui, sans-serif);
      color: var(--cf-theme-color-text, #111827);
    }

    :host([hidden]) {
      display: none;
    }

    .backdrop {
      position: absolute;
      inset: 0;
    }

    .backdrop.dimmed {
      background: rgba(0, 0, 0, 0.32);
    }

    .menu {
      position: absolute;
      min-width: 15rem;
      padding: 0.25rem;
      background: var(--cf-theme-color-surface, #ffffff);
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12), 0 0 3px rgba(0, 0, 0, 0.16);
    }

    .menu-item {
      display: block;
      width: 100%;
      padding: 0.5rem 0.75rem;
      border: none;
      border-radius: 6px;
      background: none;
      font: inherit;
      font-size: 0.8125rem;
      color: inherit;
      text-align: left;
      cursor: pointer;
      white-space: nowrap;
    }

    .menu-item:hover,
    .menu-item:focus-visible {
      background: var(--cf-theme-color-surface-hover, rgba(0, 0, 0, 0.06));
    }

    .menu-title {
      padding: 0.375rem 0.75rem;
      font-size: 0.6875rem;
      color: var(--cf-theme-color-text-muted, #6b7280);
      max-width: 18rem;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .panel {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      display: flex;
      flex-direction: column;
      width: min(56rem, 92vw);
      max-height: 86vh;
      background: var(--cf-theme-color-surface, #ffffff);
      border-radius: 12px;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.24);
      overflow: hidden;
    }

    .panel-head {
      display: flex;
      align-items: baseline;
      gap: 0.75rem;
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--cf-theme-color-border, rgba(0, 0, 0, 0.1));
    }

    .panel-head h2 {
      margin: 0;
      font-size: 0.9375rem;
    }

    .panel-head .subject {
      flex: 1;
      font-size: 0.75rem;
      color: var(--cf-theme-color-text-muted, #6b7280);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .panel-close {
      padding: 0.25rem 0.5rem;
      border: none;
      border-radius: 6px;
      background: none;
      font: inherit;
      font-size: 0.875rem;
      color: inherit;
      cursor: pointer;
    }

    .panel-close:hover {
      background: var(--cf-theme-color-surface-hover, rgba(0, 0, 0, 0.06));
    }

    .panel-body {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 1rem 1.25rem;
    }

    .file-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem;
      padding: 0.5rem 1.25rem 0;
    }

    .file-tab {
      padding: 0.25rem 0.625rem;
      border: 1px solid var(--cf-theme-color-border, rgba(0, 0, 0, 0.15));
      border-radius: 6px;
      background: none;
      font: inherit;
      font-size: 0.6875rem;
      color: var(--cf-theme-color-text-muted, #6b7280);
      cursor: pointer;
    }

    .file-tab.active {
      color: inherit;
      background: var(--cf-theme-color-surface-hover, rgba(0, 0, 0, 0.06));
    }

    pre.source {
      margin: 0;
      font-family: var(--cf-theme-font-mono, "SF Mono", monospace);
      font-size: 12px;
      line-height: 1.5;
      white-space: pre;
      tab-size: 2;
    }

    dl.facts {
      display: grid;
      grid-template-columns: minmax(8rem, max-content) 1fr;
      gap: 0.375rem 1rem;
      margin: 0;
      font-size: 0.8125rem;
    }

    dl.facts dt {
      color: var(--cf-theme-color-text-muted, #6b7280);
    }

    dl.facts dd {
      margin: 0;
      overflow-wrap: anywhere;
      font-family: var(--cf-theme-font-mono, "SF Mono", monospace);
    }

    dl.facts dd.prose {
      font-family: inherit;
    }

    .note {
      margin: 1rem 0 0;
      font-size: 0.75rem;
      color: var(--cf-theme-color-text-muted, #6b7280);
    }

    .error {
      margin: 0.75rem 0 0;
      font-size: 0.8125rem;
      color: var(--cf-theme-color-error, #b91c1c);
      overflow-wrap: anywhere;
    }
  `;

  /** The piece the menu addresses. */
  declare cell?: CellHandle;

  /** Where the click landed, in client coordinates. */
  declare x: number;
  declare y: number;

  static override properties = {
    cell: { attribute: false },
    x: { attribute: false },
    y: { attribute: false },
  };

  @state()
  private accessor panel: Panel | undefined = undefined;

  @state()
  private accessor selectedFile = 0;

  @state()
  private accessor source: PieceSourceView | undefined = undefined;

  @state()
  private accessor readError: string | undefined = undefined;

  /** Identifies the read a late response belongs to, so a stale one is dropped. */
  private readToken = 0;

  constructor() {
    super();
    this.x = 0;
    this.y = 0;
  }

  override connectedCallback() {
    super.connectedCallback();
    globalThis.addEventListener("keydown", this.#onKeyDown);
  }

  override disconnectedCallback() {
    globalThis.removeEventListener("keydown", this.#onKeyDown);
    super.disconnectedCallback();
  }

  /** Show the menu for `cell` at a click position. */
  open({ cell, x, y }: { cell: CellHandle; x: number; y: number }): void {
    this.cell = cell;
    this.x = x;
    this.y = y;
    this.panel = undefined;
    this.selectedFile = 0;
    this.source = undefined;
    this.readError = undefined;
    this.readToken++;
    this.hidden = false;
  }

  /** Hide the menu and forget the piece it was describing. */
  close(): void {
    this.hidden = true;
    this.panel = undefined;
    this.cell = undefined;
    this.source = undefined;
    this.readToken++;
  }

  #onKeyDown = (e: KeyboardEvent) => {
    if (this.hidden || e.key !== "Escape") return;
    e.preventDefault();
    // Escape steps back from a panel to the menu, then closes.
    if (this.panel) this.panel = undefined;
    else this.close();
  };

  /** Show the source file at `index`, as choosing its tab does. */
  selectFile(index: number): void {
    this.selectedFile = index;
  }

  /**
   * A right-click on the backdrop dismisses the menu rather than opening a
   * second one behind it.
   */
  private _onBackdropContextMenu = (e: Event) => {
    e.preventDefault();
    this.close();
  };

  /**
   * Show one of the panels, as choosing its entry does, reading the piece's
   * source state the first time a panel is opened for that piece.
   */
  async showPanel(panel: Panel) {
    this.panel = panel;
    this.selectedFile = 0;
    this.readError = undefined;
    const cell = this.cell;
    if (!cell || this.source !== undefined) return;
    const token = this.readToken;
    try {
      const source = await cell.runtime().getPieceSource(
        cell.id(),
        cell.space(),
      );
      if (token !== this.readToken) return;
      this.source = source;
    } catch (error) {
      if (token !== this.readToken) return;
      // A disposal race (logout, runtime swap) cancels the read; that is
      // cancellation, not a failure to report.
      if (cell.runtime().signal.aborted) return;
      this.readError = error instanceof Error ? error.message : String(error);
    }
  }

  protected override render() {
    if (this.hidden || !this.cell) return nothing;
    return this.panel ? this.#renderPanel(this.panel) : this.#renderMenu();
  }

  #renderMenu(): TemplateResult {
    // Keep the menu inside the viewport: a click near the right or bottom edge
    // clamps it back into view.
    const width = 240;
    const height = 40 + ENTRIES.length * 34;
    const left = Math.max(
      4,
      Math.min(this.x, globalThis.innerWidth - width - 4),
    );
    const top = Math.max(
      4,
      Math.min(this.y, globalThis.innerHeight - height - 4),
    );
    return html`
      <div
        class="backdrop"
        @click="${() => this.close()}"
        @contextmenu="${this._onBackdropContextMenu}"
      >
      </div>
      <div class="menu" role="menu" style="left: ${left}px; top: ${top}px">
        <div class="menu-title">Piece ${this.cell!.id()}</div>
        ${ENTRIES.map((entry) =>
          html`
            <button
              class="menu-item"
              role="menuitem"
              test-id="${entry.testId}"
              @click="${() => this.showPanel(entry.panel)}"
            >
              ${entry.label}
            </button>
          `
        )}
      </div>
    `;
  }

  #renderPanel(panel: Panel): TemplateResult {
    const title = panel === "source" ? "Source" : "Origin and history";
    const subject = this.source?.name ?? this.cell?.id() ?? "";
    return html`
      <div class="backdrop dimmed" @click="${() => this.close()}"></div>
      <div
        class="panel"
        role="dialog"
        aria-label="${title}"
        test-id="piece-panel-${panel}"
      >
        <div class="panel-head">
          <h2>${title}</h2>
          <span class="subject">${subject}</span>
          <button class="panel-close" @click="${() => this.close()}">
            Close
          </button>
        </div>
        ${panel === "source" ? this.#renderSourceTabs() : nothing}
        <div class="panel-body">
          ${this.readError
            ? html`
              <p class="error">
                Could not read this piece's source: ${this.readError}
              </p>
            `
            : this.source === undefined
            ? html`
              <p>Reading source…</p>
            `
            : panel === "source"
            ? this.#renderSource(this.source)
            : this.#renderOrigin(this.source)}
        </div>
      </div>
    `;
  }

  #renderSourceTabs() {
    const files = this.source?.files ?? [];
    if (files.length < 2) return nothing;
    return html`
      <div class="file-tabs">
        ${files.map((file, index) =>
          html`
            <button
              class="file-tab ${index === this.selectedFile ? "active" : ""}"
              @click="${() => this.selectFile(index)}"
            >
              ${file.name}
            </button>
          `
        )}
      </div>
    `;
  }

  #renderSource(source: PieceSourceView): TemplateResult {
    if (source.files.length === 0) {
      return html`
        <p>
          This piece's source is not available in its space. Its pattern is ${source
              .pattern
            ? html`
              <code>${source.pattern.identity}</code>
            `
            : "not recorded"}.
        </p>
      `;
    }
    const file =
      source.files[Math.min(this.selectedFile, source.files.length - 1)];
    return html`
      <pre class="source">${file.contents}</pre>
    `;
  }

  #renderOrigin(source: PieceSourceView): TemplateResult {
    const origin = describeOrigin(source.origin);
    return html`
      <dl class="facts">
        <dt>Origin</dt>
        <dd class="prose">
          ${origin.label}${source.origin
            ? html`
              — <code>${source.origin.url}</code>
            `
            : nothing}
          <div class="note">${origin.detail}</div>
        </dd>
        ${source.origin?.recorded
          ? html`
            <dt>Recorded as</dt>
            <dd>${source.origin.recorded}</dd>
          `
          : nothing} ${source.pattern
          ? html`
            <dt>Pattern</dt>
            <dd title="${source.pattern.identity}">
              ${shortIdentity(source.pattern.identity)} · ${source.pattern
                .symbol}
            </dd>
          `
          : nothing} ${source.setupPattern &&
            (source.setupPattern.identity !== source.pattern?.identity ||
              source.setupPattern.symbol !== source.pattern?.symbol)
          ? html`
            <dt>Setup applied for</dt>
            <dd title="${source.setupPattern.identity}">
              ${shortIdentity(source.setupPattern.identity)} · ${source
                .setupPattern.symbol}
            </dd>
          `
          : nothing} ${source.displacedPattern
          ? html`
            <dt>Previously ran</dt>
            <dd title="${source.displacedPattern.identity}">
              ${shortIdentity(source.displacedPattern.identity)} · ${source
                .displacedPattern.symbol}${source.displacedPattern.displacedAt
                ? ` · replaced ${
                  formatTimestamp(source.displacedPattern.displacedAt)
                }`
                : ""}
            </dd>
          `
          : nothing} ${source.repository
          ? html`
            <dt>Repository</dt>
            <dd>${source.repository}</dd>
          `
          : nothing} ${source.entry
          ? html`
            <dt>Entry file</dt>
            <dd>${source.entry}</dd>
          `
          : nothing}
        <dt>Files retained</dt>
        <dd>${source.files.length}</dd>
        <dt>Piece</dt>
        <dd>${source.pieceId}</dd>
        <dt>Space</dt>
        <dd>${source.space}</dd>
      </dl>
      <p class="note">
        These are the source facts this piece records. A per-revision history of
        earlier source and origin states is not recorded yet, so reverting to an
        earlier version is not offered here.
      </p>
    `;
  }
}

/**
 * The theme tokens the menu reads. Mounting outside `cf-theme`'s subtree is what
 * keeps the menu clear of a piece's clipping and scaling, and it also puts it
 * out of reach of the inherited theme variables, so these are copied across from
 * the element that opened it.
 */
const THEME_VARIABLES = [
  "--cf-theme-font-family",
  "--cf-theme-font-mono",
  "--cf-theme-color-text",
  "--cf-theme-color-text-muted",
  "--cf-theme-color-surface",
  "--cf-theme-color-surface-hover",
  "--cf-theme-color-border",
  "--cf-theme-color-error",
];

/** Copy the menu's theme tokens from `from`, resolved, onto `to`. */
function copyThemeVariables(from: Element, to: HTMLElement): void {
  const computed = globalThis.getComputedStyle(from);
  for (const name of THEME_VARIABLES) {
    const value = computed.getPropertyValue(name).trim();
    if (value) to.style.setProperty(name, value);
    else to.style.removeProperty(name);
  }
}

/**
 * The one menu element, mounted on `document.body`. A single shared instance
 * means a right-click while a menu is open replaces it rather than stacking
 * another overlay, and the element outlives the `cf-render` that opened it (a
 * piece can re-render, or stop, while its menu is up).
 */
let shared: CFPieceMenu | undefined;

/** Show the piece menu for `cell` at a click position. */
export function openPieceMenu(
  { cell, x, y, themeFrom }: {
    cell: CellHandle;
    x: number;
    y: number;
    /** The element the click came from, whose theme the menu adopts. */
    themeFrom?: Element;
  },
): CFPieceMenu {
  if (!shared || !shared.isConnected) {
    shared = globalThis.document.createElement("cf-piece-menu") as CFPieceMenu;
    globalThis.document.body.appendChild(shared);
  }
  if (themeFrom) copyThemeVariables(themeFrom, shared);
  shared.open({ cell, x, y });
  return shared;
}
