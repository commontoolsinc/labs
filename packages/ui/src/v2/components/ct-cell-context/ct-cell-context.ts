import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import type { Cell } from "@commontools/runner";

/**
 * CTCellContext - Wraps page regions and associates them with a Cell
 *
 * Provides a debugging toolbar that appears when holding Alt and hovering.
 * The toolbar allows inspecting cell values and addresses.
 *
 * @element ct-cell-context
 *
 * @property {Cell} cell - The Cell reference to associate with this context
 * @property {string} label - Optional label for display in the toolbar
 *
 * @slot - Default slot for wrapped content
 *
 * @example
 * <ct-cell-context .cell=${myCell} label="User Data">
 *   <div>Content here</div>
 * </ct-cell-context>
 */
export class CTCellContext extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        position: relative;
      }

      .container {
        border: 1px dashed transparent;
        transition: border-color 0.2s ease;
      }

      .container.alt-held {
        border-color: rgba(128, 128, 128, 0.25);
      }

      .container.alt-held:hover {
        border-color: rgba(128, 128, 128, 0.75);
      }

      .toolbar {
        position: absolute;
        top: 0;
        right: 0;
        z-index: 1000;
        display: flex;
        border: 1px solid #000;
        border-radius: 0;
        background: rgba(255, 255, 255, 0.95);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.75rem;
        overflow: hidden;
      }

      .toolbar.hidden {
        display: none;
      }

      .toolbar button {
        border: none;
        border-right: 1px solid #000;
        border-radius: 0;
        padding: 0.25rem 0.5rem;
        background: transparent;
        cursor: pointer;
        font-family: inherit;
        font-size: inherit;
        color: #000;
      }

      .toolbar button:last-child {
        border-right: none;
      }

      .toolbar button:hover {
        background: rgba(0, 0, 0, 0.05);
      }

      .toolbar button:active {
        background: rgba(0, 0, 0, 0.1);
      }

      .toolbar button.watching {
        background: #000;
        color: #fff;
      }

      .toolbar button.watching:hover {
        background: #333;
        color: #fff;
      }

      .toolbar .label {
        padding: 0.25rem 0.5rem;
        border-right: 1px solid #000;
        font-weight: 500;
        color: #666;
      }
    `,
  ];

  @property({ attribute: false })
  cell?: Cell;

  @property({ type: String })
  label?: string;

  @state()
  private _modifierHeld: boolean = false;

  @state()
  private _isHovered: boolean = false;

  @state()
  private _isWatching: boolean = false;

  @state()
  private _updateCount: number = 0;

  private _boundHandleKeyDown = this._handleKeyDown.bind(this);
  private _boundHandleKeyUp = this._handleKeyUp.bind(this);
  private _watchUnsubscribe?: () => void;

  override connectedCallback() {
    super.connectedCallback();
    // Listen for Alt key at document level
    document.addEventListener("keydown", this._boundHandleKeyDown);
    document.addEventListener("keyup", this._boundHandleKeyUp);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    // Clean up document-level listeners
    document.removeEventListener("keydown", this._boundHandleKeyDown);
    document.removeEventListener("keyup", this._boundHandleKeyUp);
    // Clean up watch subscription if active
    if (this._watchUnsubscribe) {
      this._watchUnsubscribe();
      this._watchUnsubscribe = undefined;
    }
  }

  private _handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Alt") {
      this._modifierHeld = true;
    }
  }

  private _handleKeyUp(e: KeyboardEvent) {
    if (e.key === "Alt") {
      this._modifierHeld = false;
    }
  }

  private _handleMouseEnter() {
    this._isHovered = true;
  }

  private _handleMouseLeave() {
    this._isHovered = false;
  }

  private _handleValClick() {
    if (!this.cell) {
      console.log("[ct-cell-context] No cell available");
      return;
    }
    console.log("[ct-cell-context] Cell value:", this.cell.get());
  }

  private _handleIdClick() {
    if (!this.cell) {
      console.log("[ct-cell-context] No cell available");
      return;
    }
    console.log(
      "[ct-cell-context] Cell address:",
      this.cell.getAsNormalizedFullLink(),
    );
  }

  private _handleWatchClick() {
    if (!this.cell) {
      console.log("[ct-cell-context] No cell available");
      return;
    }

    if (this._isWatching) {
      // Unwatch
      if (this._watchUnsubscribe) {
        this._watchUnsubscribe();
        this._watchUnsubscribe = undefined;
      }
      this._isWatching = false;
      this._updateCount = 0;
      const identifier = this._getCellIdentifier();
      console.log(`[ct-cell-context] Stopped watching: ${identifier}`);
    } else {
      // Watch
      const identifier = this._getCellIdentifier();
      this._updateCount = 0;
      this._watchUnsubscribe = this.cell.sink((value) => {
        this._updateCount++;
        console.log(
          `[ct-cell-context] Cell update #${this._updateCount}:`,
          value,
        );
      });
      this._isWatching = true;
      console.log(`[ct-cell-context] Started watching: ${identifier}`);
    }
  }

  private _getCellIdentifier(): string {
    if (!this.cell) return "unknown";
    if (this.label) return this.label;
    // Create short ID like ct-cell-link does
    const link = this.cell.getAsNormalizedFullLink();
    const id = link.id;
    const shortId = id.split(":").pop()?.slice(-6) ?? "???";
    return `#${shortId}`;
  }

  private get _shouldShowToolbar(): boolean {
    return this._modifierHeld && this._isHovered;
  }

  override render() {
    return html`
      <div
        class="container ${this._modifierHeld ? "alt-held" : ""}"
        @mouseenter="${this._handleMouseEnter}"
        @mouseleave="${this._handleMouseLeave}"
      >
        <div class="toolbar ${this._shouldShowToolbar ? "" : "hidden"}">
          ${this.label
            ? html`
              <div class="label">${this.label}</div>
            `
            : ""}
          <button @click="${this._handleValClick}" title="Log cell value">
            val
          </button>
          <button @click="${this._handleIdClick}" title="Log cell address">
            id
          </button>
          <button
            @click="${this._handleWatchClick}"
            class="${this._isWatching ? "watching" : ""}"
            title="${this._isWatching
              ? "Stop watching cell changes"
              : "Watch cell changes"}"
          >
            ${this._isWatching ? "unwatch" : "watch"}
          </button>
        </div>
        <slot></slot>
      </div>
    `;
  }
}

globalThis.customElements.define("ct-cell-context", CTCellContext);

declare global {
  interface HTMLElementTagNameMap {
    "ct-cell-context": CTCellContext;
  }
}
