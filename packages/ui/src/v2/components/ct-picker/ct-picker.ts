import { css, html, PropertyValues } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { createCellController } from "../../core/cell-controller.ts";
import { type Cell } from "@commontools/runner";
import "../ct-render/ct-render.ts";

/**
 * CTPicker - Visual card-stack selection component for cells with UI
 *
 * Displays a stack of renderable cells, allowing users to cycle through
 * items using arrow indicators (hover), swipe gestures (touch), or keyboard.
 * Uses index-based selection for simplicity.
 *
 * @element ct-picker
 *
 * @attr {boolean} disabled - Whether the picker is disabled
 * @attr {string} min-height - Minimum height for the picker area (default: 200px)
 *
 * @prop {Cell<any[]>} items - Array of Cells with [UI] to render in stack
 * @prop {Cell<number>} selectedIndex - Two-way bound cell for current selection index
 *
 * @fires ct-change - Fired when selection changes: { index, value, items }
 * @fires ct-focus - Fired when picker gains focus
 * @fires ct-blur - Fired when picker loses focus
 *
 * @example
 * const selectedIndex = Cell.of(0);
 * <ct-picker .items=${cellsWithUI} $selectedIndex=${selectedIndex}></ct-picker>
 */
export class CTPicker extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        width: 100%;
        position: relative;
      }

      .picker-container {
        position: relative;
        width: 100%;
        height: var(--ct-picker-min-height, 200px);
        min-height: var(--ct-picker-min-height, 200px);
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .card-stack {
        position: relative;
        width: 100%;
        height: 100%;
        flex: 1;
      }

      .card-wrapper {
        position: absolute;
        inset: 0;
        opacity: 0;
        pointer-events: none;
        overflow: hidden;
      }

      .card-wrapper.active {
        opacity: 1;
        pointer-events: auto;
      }

      .nav-arrow {
        position: absolute;
        top: 50%;
        transform: translateY(-50%);
        z-index: 10;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 2.5rem;
        height: 2.5rem;
        border: none;
        border-radius: 50%;
        background: var(--ct-theme-color-surface, rgba(255, 255, 255, 0.9));
        color: var(--ct-theme-color-text, #111827);
        cursor: pointer;
        opacity: 0;
        transition: opacity 150ms ease, background-color 150ms ease;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      }

      .nav-arrow:hover {
        background: var(--ct-theme-color-background, #ffffff);
      }

      .nav-arrow:focus {
        outline: 2px solid var(--ct-theme-color-primary, #3b82f6);
        outline-offset: 2px;
      }

      .nav-arrow.left { left: 0.5rem; }
      .nav-arrow.right { right: 0.5rem; }

      :host(:hover) .nav-arrow,
      :host(:focus-within) .nav-arrow {
        opacity: 1;
      }

      :host([disabled]) .nav-arrow,
      .nav-arrow.hidden {
        display: none;
      }

      :host([disabled]) {
        opacity: 0.5;
        cursor: not-allowed;
      }

      :host([disabled]) .picker-container {
        pointer-events: none;
      }

      .picker-container.touching {
        touch-action: none;
      }

      .arrow-icon {
        width: 1.25rem;
        height: 1.25rem;
      }
    `,
  ];

  static override properties = {
    items: { attribute: false },
    selectedIndex: { attribute: false },
    minHeight: { type: String, attribute: "min-height" },
    disabled: { type: Boolean, reflect: true },
  };

  declare items: Cell<any[]>;
  declare selectedIndex: Cell<number>;
  declare minHeight: string;
  declare disabled: boolean;

  private _touchStartX = 0;
  private _isTouching = false;

  private _cellController = createCellController<number>(this, {
    timing: { strategy: "immediate" },
    onChange: (newIndex) => {
      this.emit("ct-change", {
        index: newIndex,
        value: this.items?.key(newIndex ?? 0),
        items: this.items,
      });
    },
  });

  private get _currentIndex(): number {
    return this._cellController.getValue() ?? 0;
  }

  constructor() {
    super();
    this.minHeight = "200px";
    this.disabled = false;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.setAttribute("role", "listbox");
    this.tabIndex = this.disabled ? -1 : 0;
    this.addEventListener("keydown", this._handleKeyDown);
    this.addEventListener("focus", this._handleFocus);
    this.addEventListener("blur", this._handleBlur);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("keydown", this._handleKeyDown);
    this.removeEventListener("focus", this._handleFocus);
    this.removeEventListener("blur", this._handleBlur);
  }

  override firstUpdated() {
    this._cellController.bind(this.selectedIndex);
    this._updateAriaAttributes();
    this._updateMinHeight();
  }

  override willUpdate(changedProperties: PropertyValues) {
    super.willUpdate(changedProperties);
    if (changedProperties.has("selectedIndex")) {
      this._cellController.bind(this.selectedIndex);
    }
  }

  override updated(changed: PropertyValues) {
    if (changed.has("selectedIndex") || changed.has("items")) {
      this._updateAriaAttributes();
    }
    if (changed.has("disabled")) {
      this.tabIndex = this.disabled ? -1 : 0;
      this._updateAriaAttributes();
    }
    if (changed.has("minHeight")) {
      this._updateMinHeight();
    }
  }

  override render() {
    const items = this.items?.get() ?? [];
    const hasMultipleItems = items.length > 1;

    return html`
      <div
        class="picker-container ${this._isTouching ? "touching" : ""}"
        @touchstart="${this._handleTouchStart}"
        @touchend="${this._handleTouchEnd}"
        @touchcancel="${this._handleTouchCancel}"
      >
        <button
          class="nav-arrow left ${hasMultipleItems ? "" : "hidden"}"
          @click="${this._selectPrevious}"
          ?disabled="${this.disabled}"
          aria-label="Previous item"
          tabindex="-1"
        >
          <svg class="arrow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </button>

        <div class="card-stack">
          ${items.length
            ? items.map((_, index) => html`
                <div
                  class="card-wrapper ${index === this._currentIndex ? "active" : ""}"
                  role="option"
                  aria-selected="${index === this._currentIndex}"
                  id="picker-item-${index}"
                >
                  <ct-render .cell="${this.items.key(index)}"></ct-render>
                </div>
              `)
            : html`<div class="empty-state">No items</div>`}
        </div>

        <button
          class="nav-arrow right ${hasMultipleItems ? "" : "hidden"}"
          @click="${this._selectNext}"
          ?disabled="${this.disabled}"
          aria-label="Next item"
          tabindex="-1"
        >
          <svg class="arrow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </button>
      </div>
    `;
  }

  // --- Selection methods ---

  private _selectPrevious = (): void => {
    if (this.disabled || !this.items?.get().length) return;
    const len = this.items.get().length;
    this._selectIndex(this._currentIndex <= 0 ? len - 1 : this._currentIndex - 1);
  };

  private _selectNext = (): void => {
    if (this.disabled || !this.items?.get().length) return;
    const len = this.items.get().length;
    this._selectIndex(this._currentIndex >= len - 1 ? 0 : this._currentIndex + 1);
  };

  private _selectIndex(index: number): void {
    const len = this.items?.get()?.length ?? 0;
    if (index < 0 || index >= len || index === this._currentIndex) return;
    this._cellController.setValue(index);
    this._updateAriaAttributes();
    this.requestUpdate();
  }

  // --- Keyboard navigation ---

  private _handleKeyDown = (event: KeyboardEvent): void => {
    if (this.disabled || !this.items?.get().length) return;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        this._selectPrevious();
        break;
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        this._selectNext();
        break;
      case "Home":
        event.preventDefault();
        this._selectIndex(0);
        break;
      case "End":
        event.preventDefault();
        this._selectIndex(this.items.get().length - 1);
        break;
    }
  };

  // --- Touch/swipe handling ---

  private _handleTouchStart = (event: TouchEvent): void => {
    if (this.disabled) return;
    this._touchStartX = event.touches[0].clientX;
    this._isTouching = true;
  };

  private _handleTouchEnd = (event: TouchEvent): void => {
    if (this.disabled || !this._isTouching) return;
    const deltaX = event.changedTouches[0].clientX - this._touchStartX;
    if (Math.abs(deltaX) > 50) {
      deltaX > 0 ? this._selectPrevious() : this._selectNext();
    }
    this._isTouching = false;
  };

  private _handleTouchCancel = (): void => {
    this._isTouching = false;
  };

  // --- Focus handling ---

  private _handleFocus = (): void => {
    this.emit("ct-focus");
  };

  private _handleBlur = (): void => {
    this.emit("ct-blur");
  };

  // --- ARIA ---

  private _updateAriaAttributes(): void {
    this.setAttribute("aria-activedescendant", `picker-item-${this._currentIndex}`);
    this.setAttribute("aria-disabled", String(this.disabled));
  }

  // --- Styling helpers ---

  private _updateMinHeight(): void {
    this.style.setProperty("--ct-picker-min-height", this.minHeight);
  }

  // --- Public API ---

  getSelectedIndex(): number {
    return this._currentIndex;
  }

  getSelectedItem(): any | undefined {
    return this.items?.get()[this._currentIndex];
  }

  selectByIndex(index: number): void {
    this._selectIndex(index);
  }
}

globalThis.customElements.define("ct-picker", CTPicker);

declare global {
  interface HTMLElementTagNameMap {
    "ct-picker": CTPicker;
  }
}
