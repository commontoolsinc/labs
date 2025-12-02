import { css, html, nothing, PropertyValues } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { createCellController } from "../../core/cell-controller.ts";
import {
  type Cell,
  getCellOrThrow,
  isCell,
  isQueryResult,
} from "@commontools/runner";
import { render } from "@commontools/html";
import type { VNode } from "@commontools/runner";

// Debug logging - set to true to trace selection issues
const DEBUG_PICKER = false;
const debugLog = (...args: any[]) => {
  if (DEBUG_PICKER) console.log("[ct-picker]", ...args);
};

/**
 * Compare two values that might be cell proxies.
 * Extracts underlying cells and uses Cell.equals() for comparison.
 */
function areCellValuesSame(a: any, b: any): boolean {
  // Strict equality check first
  if (a === b) return true;

  // Try to extract underlying cells
  try {
    const cellA = isQueryResult(a) ? getCellOrThrow(a) : isCell(a) ? a : null;
    const cellB = isQueryResult(b) ? getCellOrThrow(b) : isCell(b) ? b : null;

    if (cellA && cellB) {
      const same = cellA.equals(cellB);
      debugLog("areCellValuesSame: cellA.equals(cellB) =", same);
      return same;
    }
  } catch {
    // Not cell proxies, fall through
  }

  return false;
}

/**
 * CTPicker - Visual card-stack selection component for cells with UI
 *
 * Displays a stack of renderable cells, allowing users to cycle through
 * items using arrow indicators (hover), swipe gestures (touch), or keyboard.
 * Shares selection state with ct-select via common cell binding.
 *
 * @element ct-picker
 *
 * @attr {boolean} disabled - Whether the picker is disabled
 * @attr {string} min-height - Minimum height for the picker area (default: 200px)
 *
 * @prop {Cell[]} items - Array of Cells with [UI] to render in stack
 * @prop {Cell<unknown>|unknown} value - Selected value (same API as ct-select)
 *
 * @fires ct-change - Fired when selection changes: { value, oldValue, items }
 * @fires ct-focus - Fired when picker gains focus
 * @fires ct-blur - Fired when picker loses focus
 *
 * @example
 * <ct-picker .items=${cellsWithUI} $value=${selectedCell}></ct-picker>
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

      /* Card stack area */
      .card-stack {
        position: relative;
        width: 100%;
        height: 100%;
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .card-wrapper {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        pointer-events: none;
        overflow: hidden;
      }

      .card-wrapper.active {
        opacity: 1;
        pointer-events: auto;
      }

      .card-content {
        width: 100%;
        height: 100%;
        overflow: hidden;
      }

      /* Arrow navigation buttons */
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

      .nav-arrow.left {
        left: 0.5rem;
      }

      .nav-arrow.right {
        right: 0.5rem;
      }

      /* Show arrows on hover */
      :host(:hover) .nav-arrow,
      :host(:focus-within) .nav-arrow {
        opacity: 1;
      }

      /* Hide arrows when only one item or disabled */
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

      /* Touch handling */
      .picker-container.touching {
        touch-action: none;
      }

      /* Arrow icons */
      .arrow-icon {
        width: 1.25rem;
        height: 1.25rem;
      }
    `,
  ];

  static override properties = {
    items: { attribute: false },
    value: { attribute: false },
    minHeight: { type: String, attribute: "min-height" },
    disabled: { type: Boolean, reflect: true },
  };

  declare items: Cell<any[]>;
  declare value: Cell<unknown> | unknown;
  declare minHeight: string;
  declare disabled: boolean;

  private _currentIndex = 0;
  private _touchStartX = 0;
  private _isTouching = false;
  private _renderCleanups: Map<number, () => void> = new Map();

  private _cellController = createCellController<unknown>(this, {
    timing: { strategy: "immediate" },
    onChange: (newValue, oldValue) => {
      this._syncIndexFromValue();
      this.emit("ct-change", {
        value: newValue,
        oldValue,
        items: this.items,
      });
    },
  });

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
    this._cleanupAllRenders();
  }

  override firstUpdated() {
    this._cellController.bind(this.value);
    this._syncIndexFromValue();
    this._updateAriaAttributes();
    this._updateMinHeight();
  }

  override willUpdate(changedProperties: PropertyValues) {
    super.willUpdate(changedProperties);

    if (changedProperties.has("value")) {
      this._cellController.bind(this.value);
    }
  }

  override updated(changed: PropertyValues) {
    if (changed.has("value") || changed.has("items")) {
      this._syncIndexFromValue();
      this._updateAriaAttributes();
    }

    if (changed.has("disabled")) {
      this.tabIndex = this.disabled ? -1 : 0;
      this._updateAriaAttributes();
    }

    if (changed.has("minHeight")) {
      this._updateMinHeight();
    }

    if (changed.has("items")) {
      this._renderAllItems();
    }
  }

  override render() {
    const hasMultipleItems = this.items?.get().length > 1;

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
          ${this.items?.get().length
            ? this.items.get().map(
              (_, index) =>
                html`
                  <div
                    class="card-wrapper ${index === this._currentIndex
                      ? "active"
                      : ""}"
                    role="option"
                    aria-selected="${index === this._currentIndex}"
                    id="picker-item-${index}"
                  >
                    <div class="card-content" data-index="${index}"></div>
                  </div>
                `,
            )
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
    if (this.disabled || !this.items?.get().length) return;
    const newIndex = this._currentIndex <= 0
      ? this.items.get().length - 1
      : this._currentIndex - 1;
    this._selectIndex(newIndex);
  };

  private _selectNext = (): void => {
    if (this.disabled || !this.items?.get().length) return;
    const newIndex = this._currentIndex >= this.items.get().length - 1
      ? 0
      : this._currentIndex + 1;
    this._selectIndex(newIndex);
  };

  private _selectFirst = (): void => {
    if (this.disabled || !this.items?.get().length) return;
    this._selectIndex(0);
  };

  private _selectLast = (): void => {
    if (this.disabled || !this.items?.get().length) return;
    this._selectIndex(this.items.get().length - 1);
  };

  private _selectIndex(index: number): void {
    debugLog("_selectIndex called", {
      index,
      currentIndex: this._currentIndex,
      itemsLength: this.items?.get().length,
    });

    if (index < 0 || index >= this.items.get().length) {
      debugLog("_selectIndex: index out of bounds, returning");
      return;
    }
    if (index === this._currentIndex) {
      debugLog("_selectIndex: same as current, returning");
      return;
    }

    this._currentIndex = index;
    const selectedItem = this.items.key(index);
    debugLog(
      "_selectIndex: setting value to item at index",
      index,
      selectedItem,
    );

    // Update value through cell controller
    this._cellController.setValue(selectedItem);
    this._updateAriaAttributes();
    this.requestUpdate();
  }

  private _syncIndexFromValue(): void {
    debugLog("_syncIndexFromValue called", {
      itemsLength: this.items?.get().length,
    });

    if (!this.items?.get().length) {
      this._currentIndex = 0;
      debugLog("_syncIndexFromValue: no items, setting index to 0");
      return;
    }

    const currentValue = this._cellController.getValue();
    debugLog("_syncIndexFromValue: currentValue from controller", currentValue);

    // Debug: check comparison for each item
    this.items.get().forEach((item, i) => {
      const same = areCellValuesSame(item, currentValue);
      debugLog(
        `_syncIndexFromValue: areCellValuesSame(items[${i}], currentValue) =`,
        same,
      );
    });

    // Use our custom comparison that properly handles cell proxies
    const index = this.items.get().findIndex((item) =>
      areCellValuesSame(item, currentValue)
    );
    debugLog("_syncIndexFromValue: found index", index);

    if (index >= 0) {
      this._currentIndex = index;
      debugLog("_syncIndexFromValue: setting _currentIndex to", index);
    } else if (this.items.get().length > 0) {
      // Default to first item if value not found
      this._currentIndex = 0;
      debugLog("_syncIndexFromValue: value not found, defaulting to 0");
    }
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
        this._selectFirst();
        break;
      case "End":
        event.preventDefault();
        this._selectLast();
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
    const threshold = 50;

    if (Math.abs(deltaX) > threshold) {
      if (deltaX > 0) {
        this._selectPrevious(); // swipe right = previous
      } else {
        this._selectNext(); // swipe left = next
      }
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

  // --- Cell UI rendering ---

  private _renderAllItems(): void {
    this._cleanupAllRenders();

    // Wait for next frame to ensure DOM is ready
    requestAnimationFrame(() => {
      this.items?.get().forEach((cell, index) => {
        this._renderItemAtIndex(cell, index);
      });
    });
  }

  private _renderItemAtIndex(cell: any, index: number): void {
    const container = this.shadowRoot?.querySelector(
      `.card-content[data-index="${index}"]`,
    ) as HTMLElement | null;

    if (!container) return;

    // Clean up previous render for this index
    const existingCleanup = this._renderCleanups.get(index);
    if (existingCleanup) {
      existingCleanup();
      this._renderCleanups.delete(index);
    }

    try {
      // Render the cell's UI into the container
      const cleanup = render(container, cell as Cell<VNode>);
      this._renderCleanups.set(index, cleanup);
    } catch (error) {
      console.error(
        `[ct-picker] Error rendering item at index ${index}:`,
        error,
      );
      // Fallback: show cell link
      container.innerHTML = `<ct-cell-link></ct-cell-link>`;
      const cellLink = container.querySelector("ct-cell-link") as any;
      if (cellLink) {
        cellLink.cell = cell;
      }
    }
  }

  private _cleanupAllRenders(): void {
    this._renderCleanups.forEach((cleanup) => cleanup());
    this._renderCleanups.clear();
  }

  // --- Public API ---

  /**
   * Get the currently selected index
   */
  getSelectedIndex(): number {
    return this._currentIndex;
  }

  /**
   * Get the currently selected item
   */
  getSelectedItem(): any | undefined {
    return this.items?.get()[this._currentIndex];
  }

  /**
   * Select an item by index
   */
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
