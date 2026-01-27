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
 * @prop {CellHandle<any[]> | any[]} items - Array of Cells with [UI] to render in stack (CellHandle or plain array)
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
        --stack-offset: 12px;
        --stack-inset-1: 4%;
        --stack-inset-2: 8%;
      }

      .picker-container {
        position: relative;
        width: 100%;
        min-height: var(--ct-picker-min-height, 200px);
        display: flex;
        align-items: flex-start;
        justify-content: center;
        /* Extra padding at bottom for stacked cards to show */
        margin-bottom: calc(var(--stack-offset) * 6 + 8px);
      }

      .card-stack {
        position: relative;
        width: 80%;
        min-height: var(--ct-picker-min-height, 200px);
      }

      .card-wrapper {
        position: absolute;
        top: 0;
        min-height: var(--ct-picker-min-height, 200px);
        display: flex;
        align-items: stretch;
        justify-content: center;
        transition: all 300ms ease;
        border-radius: var(--ct-theme-border-radius, 0.5rem);
        background: var(--ct-theme-color-surface, #ffffff);
        overflow: hidden;
        transform-origin: center top;
        /* Animated gradient drop shadow */
        animation: glow-shift 8s ease infinite;
      }

      @keyframes glow-shift {
        0%, 100% {
          box-shadow:
            0 2px 8px rgba(168, 85, 247, 0.15),
            0 4px 16px rgba(168, 85, 247, 0.1);
          }
          33% {
            box-shadow:
              0 2px 8px rgba(59, 130, 246, 0.15),
              0 4px 16px rgba(59, 130, 246, 0.1);
            }
            66% {
              box-shadow:
                0 2px 8px rgba(16, 185, 129, 0.12),
                0 4px 16px rgba(16, 185, 129, 0.08);
              }
            }

            @keyframes float-0 {
              0%, 100% {
                transform: translateY(0) rotate(0deg);
              }
              50% {
                transform: translateY(-3px) rotate(0deg);
              }
            }

            @keyframes float-1 {
              0%, 100% {
                transform: translateY(var(--stack-offset)) rotate(1deg);
              }
              50% {
                transform: translateY(calc(var(--stack-offset) - 2px)) rotate(1deg);
              }
            }

            @keyframes float-2 {
              0%, 100% {
                transform: translateY(calc(var(--stack-offset) * 2)) rotate(-1.5deg);
              }
              50% {
                transform: translateY(calc(var(--stack-offset) * 2 - 1.5px))
                  rotate(-1.5deg);
                }
              }

              /* Stack positions: cards behind are inset and offset */
              .card-wrapper[data-position="0"] {
                z-index: 3;
                left: 0;
                right: 0;
                opacity: 1;
                pointer-events: auto;
                animation: glow-shift 8s ease infinite, float-0 6s ease-in-out infinite;
              }

              .card-wrapper[data-position="1"] {
                z-index: 2;
                left: var(--stack-inset-1);
                right: var(--stack-inset-1);
                opacity: 0.5;
                pointer-events: none;
                filter: brightness(0.92);
                animation: glow-shift 8s ease infinite, float-1 7s ease-in-out infinite;
              }

              .card-wrapper[data-position="2"] {
                z-index: 1;
                left: var(--stack-inset-2);
                right: var(--stack-inset-2);
                opacity: 0.3;
                pointer-events: none;
                filter: brightness(0.85);
                animation: glow-shift 8s ease infinite, float-2 8s ease-in-out infinite;
              }

              .card-wrapper[data-position="hidden"] {
                z-index: 0;
                left: var(--stack-inset-2);
                right: var(--stack-inset-2);
                transform: translateY(calc(var(--stack-offset) * 2)) rotate(0deg);
                opacity: 0;
                pointer-events: none;
                animation: none;
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

          /**
           * Calculate the visual position of a card in the stack.
           * Position 0 = front (selected), 1 = first behind, 2 = second behind, hidden = not visible
           */
          private _getStackPosition(
            index: number,
            currentIndex: number,
            totalItems: number,
          ): string {
            if (totalItems <= 1) return index === currentIndex ? "0" : "hidden";

            // Calculate distance from current index (wrapping around)
            const distance = (index - currentIndex + totalItems) % totalItems;

            // Show up to 3 cards in the stack (0, 1, 2), hide the rest
            if (distance === 0) return "0";
            if (distance === 1) return "1";
            if (distance === 2) return "2";
            return "hidden";
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
                    ? items.map((_, index) =>
                      html`
                        <div
                          class="card-wrapper"
                          data-position="${this._getStackPosition(
                            index,
                            currentIndex,
                            items.length,
                          )}"
                          role="option"
                          aria-selected="${index === currentIndex}"
                          id="picker-item-${index}"
                        >
                          <ct-render
                            .cell="${this._getItemAt(index)}"
                            variant="preview"
                          ></ct-render>
                        </div>
                      `
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
