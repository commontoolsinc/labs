import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

// Import Cell type from ct-outliner
import type { Cell } from "../ct-outliner/simple-cell.ts";

/**
 * CTCellTester - Simple component for testing cell operations
 *
 * @element ct-cell-tester
 *
 * @attr {Cell<any>} cell - The cell to test with
 *
 * @example
 * const cell = createSimpleCell(0);
 * <ct-cell-tester .cell=${cell}></ct-cell-tester>
 */

export class CTCellTester extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        padding: 1rem;
        border: 1px solid var(--ct-colors-gray-300);
        border-radius: var(--ct-border-radius-md);
        background-color: var(--ct-colors-gray-50);
      }

      .container {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        align-items: flex-start;
      }

      .current-value {
        font-family: var(--ct-font-family-mono);
        font-size: var(--ct-font-size-sm);
        padding: 0.25rem 0.5rem;
        background-color: var(--ct-colors-gray-100);
        border: 1px solid var(--ct-colors-gray-200);
        border-radius: var(--ct-border-radius-sm);
        color: var(--ct-colors-gray-700);
      }

      .test-button {
        padding: 0.5rem 1rem;
        background-color: var(--ct-colors-primary-500);
        color: white;
        border: none;
        border-radius: var(--ct-border-radius-md);
        cursor: pointer;
        font-size: var(--ct-font-size-sm);
        font-weight: var(--ct-font-weight-medium);
        transition: background-color 0.2s;
      }

      .test-button:hover {
        background-color: var(--ct-colors-primary-600);
      }

      .test-button:disabled {
        background-color: var(--ct-colors-gray-300);
        cursor: not-allowed;
      }

      .label {
        font-size: var(--ct-font-size-sm);
        color: var(--ct-colors-gray-600);
        font-weight: var(--ct-font-weight-medium);
      }
    `,
  ];

  static override properties = {
    cell: { type: Object },
  };

  declare cell: Cell<any>;

  constructor() {
    super();
    this.cell = {
      get: () => null,
      set: () => {},
    };
  }

  override render() {
    const currentValue = this.cell ? this.cell.get() : null;
    const displayValue = currentValue !== null ? String(currentValue) : "null";

    return html`
      <div class="container">
        <div class="label">Cell Tester</div>
        <div class="current-value">
          Current value: ${displayValue}
        </div>
        <button 
          class="test-button"
          @click="${this._handleClick}"
          ?disabled="${!this.cell}"
        >
          Set Random Number
        </button>
      </div>
    `;
  }

  private _handleClick() {
    if (!this.cell) return;

    const randomNumber = Math.floor(Math.random() * 1000);
    this.cell.set(randomNumber);
    
    // Trigger a re-render to show the updated value
    this.requestUpdate();
  }
}

globalThis.customElements.define("ct-cell-tester", CTCellTester);