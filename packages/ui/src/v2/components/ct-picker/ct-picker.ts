import { css, html, PropertyValues } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import {
  createArrayCellController,
  createCellController,
} from "../../core/cell-controller.ts";
import { type CellHandle } from "@commontools/runtime-client";
import { numberSchema } from "@commontools/runner/schemas";
import "../ct-render/ct-render.ts";

/**
 * CTPicker - Simple carousel selection component for cells with UI
 *
 * Displays one renderable cell at a time, allowing users to cycle through
 * items using arrow indicators (hover), swipe gestures (touch), or keyboard.
 * Uses index-based selection for simplicity.
 *
 * @element ct-picker
 *
 * @attr {boolean} disabled - Whether the picker is disabled
 * @attr {string} min-height - Optional minimum height for the picker area
 *
 * @prop {CellHandle<any[]> | any[]} items - Array of Cells with [UI] to render (CellHandle or plain array)
 * @prop {CellHandle<number>} selectedIndex - Two-way bound cell for current selection index
 *
 * @fires ct-change - Fired when selection changes: { index, value, items }
 * @fires ct-confirm - Fired when Enter/Space pressed to confirm selection: { index, value }
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
        display: flex;
        align-items: flex-start;
        justify-content: center;
      }

      .card-stack {
        position: relative;
        width: 80%;
      }

      .card-wrapper {
        position: relative;
        display: flex;
        align-items: stretch;
        justify-content: center;
        border-radius: var(--ct-theme-border-radius, 0.5rem);
        background: var(--ct-theme-color-surface, #ffffff);
        overflow: hidden;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        min-height: var(--ct-picker-min-height, auto);
      }

      .card-wrapper ct-render {
        width: 100%;
        height: 100%;
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
        background: var(--ct-theme-color-surface, rgba(255, 255, 255, 0.95));
        color: var(--ct-theme-color-text, #111827);
        cursor: pointer;
        opacity: 0;
        transition:
          opacity 150ms ease,
          background-color 150ms ease,
          transform 150ms ease;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      }

      .nav-arrow:hover {
        background: var(--ct-theme-color-background, #ffffff);
        transform: translateY(-50%) scale(1.05);
      }

      .nav-arrow:active {
        transform: translateY(-50%) scale(0.95);
      }

      .nav-arrow:focus {
        outline: 2px solid var(--ct-theme-color-primary, #3b82f6);
        outline-offset: 2px;
      }

      .nav-arrow.left {
        left: 0;
      }
      .nav-arrow.right {
        right: 0;
      }

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

      .empty-state {
        color: var(--ct-theme-color-text-secondary, #6b7280);
        font-size: 0.875rem;
      }

      .position-indicators {
        display: flex;
        justify-content: center;
        gap: 0.5rem;
        margin-top: 0.75rem;
      }

      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--ct-theme-color-border, #e5e7eb);
      }

      .dot.active {
        background: var(--ct-theme-color-primary, #3b82f6);
      }
    `,
  ];

  static override properties = {
    items: { attribute: false },
    selectedIndex: { attribute: false },
    minHeight: { type: String, attribute: "min-height" },
    disabled: { type: Boolean, reflect: true },
  };

  declare items: CellHandle<any[]> | any[];
  declare selectedIndex: CellHandle<number>;
  declare minHeight: string;
  declare disabled: boolean;

  private _touchStartX = 0;
  private _isTouching = false;

  /**
   * Get items array - uses cell controller for proper subscription
   */
  private _getItems(): readonly any[] {
    // Use the cell controller which handles subscription and value loading
    return this._itemsCellController.getValue() ?? [];
  }

  /**
   * Get item at index - uses cell controller for proper access
   */
  private _getItemAt(index: number): any {
    // If items is a CellHandle, use .key() for reactive access
    const cell = this._itemsCellController.getCell();
    if (cell) {
      return cell.key(index);
    }
    // Plain array - return element directly
    const items = this._getItems();
    return items[index];
  }

  private _indexCellController = createCellController<number>(this, {
    timing: { strategy: "immediate" },
    onChange: (newIndex) => {
      this.emit("ct-change", {
        index: newIndex,
        value: this._getItemAt(newIndex ?? 0),
        items: this.items,
      });
    },
  });

  // Cell controller for items - handles subscription to load cell values
  private _itemsCellController = createArrayCellController<any>(this, {
    timing: { strategy: "immediate" },
  });

  private get _currentIndex(): number {
    return this._indexCellController.getValue() ?? 0;
  }

  constructor() {
    super();
    this.minHeight = "";
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
    this._indexCellController.bind(this.selectedIndex, numberSchema);
    this._itemsCellController.bind(this.items as any);
    this._updateAriaAttributes();
    this._updateMinHeight();
  }

  override willUpdate(changedProperties: PropertyValues) {
    super.willUpdate(changedProperties);
    if (changedProperties.has("selectedIndex")) {
      this._indexCellController.bind(this.selectedIndex, numberSchema);
    }
    if (changedProperties.has("items")) {
      this._itemsCellController.bind(this.items as any);
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
    const items = this._getItems();
    const hasMultipleItems = items.length > 1;
    const currentIndex = this._currentIndex;

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
          <svg
            class="arrow-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </button>

        <div class="card-stack">
          ${items.length
            ? html`
              <div
                class="card-wrapper"
                role="option"
                aria-selected="true"
                id="picker-item-${currentIndex}"
              >
                <ct-render
                  .cell="${this._getItemAt(currentIndex)}"
                  variant="preview"
                ></ct-render>
              </div>
              ${hasMultipleItems
                ? html`
                  <div class="position-indicators">
                    ${items.map(
                      (_, i) =>
                        html`
                          <span
                            class="dot ${i === currentIndex ? "active" : ""}"
                          ></span>
                        `,
                    )}
                  </div>
                `
                : ""}
            `
            : html`
              <div class="empty-state">No items</div>
            `}
        </div>

        <button
          class="nav-arrow right ${hasMultipleItems ? "" : "hidden"}"
          @click="${this._selectNext}"
          ?disabled="${this.disabled}"
          aria-label="Next item"
          tabindex="-1"
        >
          <svg
            class="arrow-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </button>
      </div>
    `;
  }

  // --- Selection methods ---

  private _selectPrevious = (): void => {
    const items = this._getItems();
    if (this.disabled || !items.length) return;
    const len = items.length;
    this._selectIndex(
      this._currentIndex <= 0 ? len - 1 : this._currentIndex - 1,
    );
  };

  private _selectNext = (): void => {
    const items = this._getItems();
    if (this.disabled || !items.length) return;
    const len = items.length;
    this._selectIndex(
      this._currentIndex >= len - 1 ? 0 : this._currentIndex + 1,
    );
  };

  private _selectIndex(index: number): void {
    const len = this._getItems().length;
    if (index < 0 || index >= len || index === this._currentIndex) {
      return;
    }
    this._indexCellController.setValue(index);
    this._updateAriaAttributes();
    this.requestUpdate();
  }

  // --- Keyboard navigation ---

  private _handleKeyDown = (event: KeyboardEvent): void => {
    const items = this._getItems();
    if (this.disabled || !items.length) return;
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
        this._selectIndex(items.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        this.emit("ct-confirm", {
          index: this._currentIndex,
          value: this._getItemAt(this._currentIndex),
        });
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
    this.setAttribute(
      "aria-activedescendant",
      `picker-item-${this._currentIndex}`,
    );
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
    return this._getItemAt(this._currentIndex);
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
