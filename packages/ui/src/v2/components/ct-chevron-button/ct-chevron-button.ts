import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * A minimal chevron button that rotates between up/down states
 *
 * @element ct-chevron-button
 *
 * @attr {boolean} expanded - Whether the chevron is in expanded (down) state
 * @attr {boolean} loading - Whether to show loading animation instead of chevron
 * @attr {string} size - Size variant: "sm" | "md" | "lg" (default: "md")
 *
 * @fires ct-toggle - Fired when button is clicked
 *
 * @example
 * <ct-chevron-button
 *   ?expanded=${showContent}
 *   ?loading=${isPending}
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
        padding: 0;
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

      /* Loading animation - scrolling sine wave */
      .loading-wave {
        display: flex;
        overflow: hidden;
        width: var(--chevron-size, 24px);
      }

      .loading-wave svg {
        width: 48px;
        min-width: 48px;
        animation: wave-scroll 0.8s linear infinite;
      }

      @keyframes wave-scroll {
        0% {
          transform: translateX(-12px);
        }
        100% {
          transform: translateX(-24px);
        }
      }
    `,
  ];

  static override properties = {
    expanded: { type: Boolean, reflect: true },
    loading: { type: Boolean, reflect: true },
    size: { type: String, reflect: true },
  };

  @property({ type: Boolean, reflect: true })
  declare expanded: boolean;

  @property({ type: Boolean, reflect: true })
  declare loading: boolean;

  @property({ type: String, reflect: true })
  declare size: "sm" | "md" | "lg";

  constructor() {
    super();
    this.expanded = false;
    this.loading = false;
    this.size = "md";
  }

  private _handleClick = () => {
    this.emit("ct-toggle");
  };

  override render() {
    return html`
      <button
        type="button"
        class="chevron-button"
        @click="${this._handleClick}"
        aria-label="${this.loading
          ? "Loading"
          : this.expanded
          ? "Collapse"
          : "Expand"}"
        aria-expanded="${this.expanded}"
        title="${this.loading ? "Loading..." : this.expanded ? "Hide" : "Show"}"
      >
        ${this.loading
          ? html`
            <span class="loading-wave">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path
                  d="M 0 12 Q 3 9, 6 12 T 12 12 T 18 12 T 24 12 T 30 12 T 36 12 T 42 12 T 48 12 T 54 12 T 60 12 T 66 12 T 72 12 T 78 12 T 84 12 T 90 12 T 96 12"
                />
              </svg>
            </span>
          `
          : html`
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
          `}
      </button>
    `;
  }
}

if (!globalThis.customElements.get("ct-chevron-button")) {
  globalThis.customElements.define("ct-chevron-button", CTChevronButton);
}
