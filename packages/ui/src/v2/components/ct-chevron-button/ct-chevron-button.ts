import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * A minimal chevron button that rotates between up/down states
 *
 * @element ct-chevron-button
 *
 * @attr {boolean} expanded - Whether the chevron is in expanded (down) state
 * @attr {string} size - Size variant: "sm" | "md" | "lg" (default: "md")
 *
 * @fires ct-toggle - Fired when button is clicked
 *
 * @example
 * <ct-chevron-button
 *   ?expanded=${showContent}
 *   @ct-toggle=${handleToggle}
 * ></ct-chevron-button>
 */
export class CTChevronButton extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        box-sizing: border-box;
      }

      *,
      *::before,
      *::after {
        box-sizing: inherit;
      }

      .chevron-button {
        background: none;
        border: none;
        cursor: pointer;
        padding: 6px 0;
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--ct-theme-color-text-muted, var(--ct-color-gray-500, #999));
        transition: color 200ms ease;
      }

      .chevron-button:hover {
        color: var(--ct-theme-color-text, var(--ct-color-gray-700, #666));
      }

      .chevron-button:active {
        color: var(--ct-theme-color-text, var(--ct-color-gray-900, #333));
      }

      .chevron-icon {
        display: flex;
        transition: transform 300ms cubic-bezier(0.34, 1.56, 0.64, 1);
      }

      :host([expanded]) .chevron-icon {
        transform: rotate(180deg);
      }

      /* Size variants */
      :host([size="sm"]) .chevron-button {
        padding: 4px 0;
      }

      :host([size="lg"]) .chevron-button {
        padding: 8px 0;
      }

      svg {
        width: var(--chevron-size, 24px);
        height: var(--chevron-size, 24px);
      }

      :host([size="sm"]) svg {
        --chevron-size: 20px;
      }

      :host([size="lg"]) svg {
        --chevron-size: 28px;
      }
    `,
  ];

  static override properties = {
    expanded: { type: Boolean, reflect: true },
    size: { type: String, reflect: true },
  };

  @property({ type: Boolean, reflect: true })
  declare expanded: boolean;

  @property({ type: String, reflect: true })
  declare size: "sm" | "md" | "lg";

  constructor() {
    super();
    this.expanded = false;
    this.size = "md";
  }

  private _handleClick = () => {
    this.emit("ct-toggle");
  };

  override render() {
    return html`
      <button
        class="chevron-button"
        @click="${this._handleClick}"
        aria-label="${this.expanded ? "Collapse" : "Expand"}"
        aria-expanded="${this.expanded}"
        title="${this.expanded ? "Hide" : "Show"}"
      >
        <span class="chevron-icon">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="18 15 12 9 6 15"></polyline>
          </svg>
        </span>
      </button>
    `;
  }
}

if (!globalThis.customElements.get("ct-chevron-button")) {
  globalThis.customElements.define("ct-chevron-button", CTChevronButton);
}
