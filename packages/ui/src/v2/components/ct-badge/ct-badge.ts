import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTBadge - Status indicator or label with multiple visual variants
 *
 * @element ct-badge
 *
 * @attr {string} variant - Visual style variant: "default" | "secondary" | "destructive" | "outline"
 * @attr {boolean} removable - Shows an X button to remove the badge
 *
 * @slot - Default slot for badge text
 *
 * @fires ct-remove - Fired when X button is clicked (if removable)
 *
 * @example
 * <ct-badge variant="secondary" removable>Status</ct-badge>
 */

export type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

export class CTBadge extends BaseElement {
  static override styles = css`
    :host {
      display: inline-block;
      box-sizing: border-box;
    }

    *,
    *::before,
    *::after {
      box-sizing: inherit;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.125rem 0.625rem;
      font-size: 0.75rem;
      font-weight: 600;
      line-height: 1;
      border-radius: 9999px;
      border: 1px solid transparent;
      transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
    }

    /* Variant styles */
    .badge.default {
      background-color: var(--primary, hsl(212, 100%, 47%));
      color: var(--primary-foreground, hsl(0, 0%, 100%));
    }

    .badge.secondary {
      background-color: var(--secondary, hsl(0, 0%, 96%));
      color: var(--secondary-foreground, hsl(0, 0%, 9%));
    }

    .badge.destructive {
      background-color: var(--destructive, hsl(0, 100%, 50%));
      color: var(--destructive-foreground, hsl(0, 0%, 100%));
    }

    .badge.outline {
      background-color: transparent;
      border-color: var(--border, hsl(0, 0%, 89%));
      color: var(--foreground, hsl(0, 0%, 9%));
    }

    /* Close button */
    .close-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      padding: 0;
      margin: 0;
      margin-left: 0.125rem;
      margin-right: -0.25rem;
      background: none;
      border: none;
      cursor: pointer;
      opacity: 0.7;
      transition: opacity 150ms;
      color: currentColor;
    }

    .close-button:hover {
      opacity: 1;
    }

    .close-button:focus-visible {
      outline: 2px solid var(--ring, hsl(212, 100%, 47%));
      outline-offset: 2px;
      border-radius: 2px;
    }

    .close-button svg {
      width: 100%;
      height: 100%;
    }
  `;

  static override properties = {
    variant: { type: String },
    removable: { type: Boolean },
  };

  declare variant: BadgeVariant;
  declare removable: boolean;

  constructor() {
    super();
    this.variant = "default";
    this.removable = false;
  }

  override render() {
    return html`
      <div
        class="badge ${this.variant}"
        part="badge"
      >
        <slot></slot>
        ${this.removable
        ? html`
          <button
            type="button"
            class="close-button"
            part="close-button"
            aria-label="Remove"
            @click="${this._handleRemove}"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        `
        : null}
      </div>
    `;
  }

  private _handleRemove(event: Event) {
    event.preventDefault();
    event.stopPropagation();

    // Emit ct-remove event
    this.emit("ct-remove", {
      variant: this.variant,
    });
  }
}

globalThis.customElements.define("ct-badge", CTBadge);
