import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTCard - Content container with support for header, content, and footer sections
 *
 * @element ct-card
 *
 * @attr {boolean} clickable - Whether the card responds to click interactions
 *
 * @slot header - Card header content
 * @slot content - Main card content
 * @slot footer - Card footer content
 * @slot - Default slot (alternative to using named slots)
 *
 * @example
 * <ct-card>
 *   <h3 slot="header">Card Title</h3>
 *   <p slot="content">Card content goes here</p>
 *   <ct-button slot="footer">Action</ct-button>
 * </ct-card>
 */

export class CTCard extends BaseElement {
  static override styles = css`
    :host {
      display: block;
      box-sizing: border-box;
    }

    *,
    *::before,
    *::after {
      box-sizing: inherit;
    }

    .card {
      border-radius: var(--radius-lg, 0.5rem);
      border: 1px solid var(--border, hsl(0, 0%, 89%));
      background-color: var(--card, hsl(0, 0%, 100%));
      color: var(--card-foreground, hsl(0, 0%, 9%));
      overflow: hidden;
      transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
    }

    .card[tabindex="0"] {
      cursor: pointer;
    }

    .card[tabindex="0"]:hover {
      background-color: var(--accent, hsl(0, 0%, 96%));
      transform: translateY(-1px);
      box-shadow:
        0 4px 6px -1px rgba(0, 0, 0, 0.1),
        0 2px 4px -1px rgba(0, 0, 0, 0.06);
      }

      .card[tabindex="0"]:focus-visible {
        outline: 2px solid var(--ring, hsl(212, 100%, 47%));
        outline-offset: 2px;
      }

      .card[tabindex="0"]:active {
        transform: translateY(0);
      }

      /* Header section */
      .card-header:not(:empty) {
        padding: 1.5rem;
        padding-bottom: 0;
      }

      /* Title wrapper for title and action slots */
      .card-title-wrapper {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 1rem;
      }

      .card-title-wrapper:not(:has([slot])) {
        display: none;
      }

      /* Title slot styling */
      ::slotted([slot="title"]) {
        font-size: 1.5rem;
        font-weight: 600;
        line-height: 2rem;
        letter-spacing: -0.025em;
        margin: 0;
      }

      /* Description slot styling */
      ::slotted([slot="description"]) {
        font-size: 0.875rem;
        line-height: 1.25rem;
        color: var(--muted-foreground, hsl(0, 0%, 45%));
        margin-top: 0.25rem;
      }

      /* Content section */
      .card-content:not(:empty) {
        padding: 1.5rem;
      }

      /* Footer section */
      .card-footer:not(:empty) {
        padding: 1.5rem;
        padding-top: 0;
      }

      /* Adjust spacing when sections are used together */
      .card-header:not(:empty) + .card-content:not(:empty) {
        padding-top: 1.5rem;
      }

      .card-content:not(:empty) + .card-footer:not(:empty) {
        padding-top: 1.5rem;
      }
    `;

    static override properties = {
      clickable: { type: Boolean },
    };

    declare clickable: boolean;

    constructor() {
      super();
      this.clickable = false;
    }

    override connectedCallback() {
      super.connectedCallback();
      if (this.clickable) {
        this.addEventListener("click", this._handleClick);
        this.addEventListener("keydown", this._handleKeydown);
      }
    }

    override disconnectedCallback() {
      super.disconnectedCallback();
      this.removeEventListener("click", this._handleClick);
      this.removeEventListener("keydown", this._handleKeydown);
    }

    override updated(changedProperties: Map<string, any>) {
      if (changedProperties.has("clickable")) {
        if (this.clickable) {
          this.addEventListener("click", this._handleClick);
          this.addEventListener("keydown", this._handleKeydown);
        } else {
          this.removeEventListener("click", this._handleClick);
          this.removeEventListener("keydown", this._handleKeydown);
        }
      }
    }

    override render() {
      return html`
        <div
          class="card"
          part="card"
          tabindex="${this.clickable ? "0" : null}"
          role="${this.clickable ? "button" : null}"
        >
          <div class="card-header" part="header">
            <slot name="header">
              <div class="card-title-wrapper">
                <slot name="title"></slot>
                <slot name="action"></slot>
              </div>
              <slot name="description"></slot>
            </slot>
          </div>
          <div class="card-content" part="content">
            <slot name="content">
              <slot></slot>
            </slot>
          </div>
          <div class="card-footer" part="footer">
            <slot name="footer"></slot>
          </div>
        </div>
      `;
    }

    private _handleClick = (_event: Event): void => {
      if (!this.clickable) return;

      // Emit a custom click event
      this.emit("ct-card-click", {
        clickable: this.clickable,
      });
    };

    private _handleKeydown = (event: KeyboardEvent): void => {
      if (!this.clickable) return;

      // Handle Enter and Space keys for accessibility
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this._handleClick(event);
      }
    };

    /**
     * Focus the card programmatically (only works when clickable)
     */
    override focus(): void {
      if (this.clickable) {
        const card = this.shadowRoot?.querySelector(".card") as HTMLElement;
        card?.focus();
      }
    }

    /**
     * Blur the card programmatically
     */
    override blur(): void {
      const card = this.shadowRoot?.querySelector(".card") as HTMLElement;
      card?.blur();
    }
  }

  globalThis.customElements.define("ct-card", CTCard);
