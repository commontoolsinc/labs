import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CFBadge - Status indicator or label with multiple visual variants
 *
 * @element cf-badge
 *
 * @attr {string} variant - Visual style variant: "default" | "secondary" | "destructive" | "outline"
 * @attr {boolean} removable - Shows an X button to remove the badge
 *
 * @slot - Default slot for badge text
 *
 * @fires cf-remove - Fired when X button is clicked (if removable)
 *
 * @example
 * <cf-badge variant="secondary" removable>Status</cf-badge>
 */

export type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

export class CFBadge extends BaseElement {
  static override styles = css`
    :host {
      --cf-badge-color-primary: var(
        --cf-theme-color-primary,
        hsl(212, 100%, 47%)
      );
      --cf-badge-color-primary-foreground: var(
        --cf-theme-color-primary-foreground,
        hsl(0, 0%, 100%)
      );
      --cf-badge-color-secondary: var(
        --cf-theme-color-secondary,
        hsl(0, 0%, 96%)
      );
      --cf-badge-color-secondary-foreground: var(
        --cf-theme-color-secondary-foreground,
        hsl(0, 0%, 9%)
      );
      --cf-badge-color-destructive: var(
        --cf-theme-color-error,
        hsl(0, 100%, 50%)
      );
      --cf-badge-color-destructive-foreground: var(
        --cf-theme-color-error-foreground,
        hsl(0, 0%, 100%)
      );
      --cf-badge-color-border: var(--cf-theme-color-border, hsl(0, 0%, 89%));
      --cf-badge-color-text: var(--cf-theme-color-text, hsl(0, 0%, 9%));
      --cf-badge-color-ring: var(--cf-theme-color-primary, hsl(212, 100%, 47%));

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
      background-color: var(--cf-badge-color-primary, hsl(212, 100%, 47%));
      color: var(--cf-badge-color-primary-foreground, hsl(0, 0%, 100%));
    }

    .badge.secondary {
      background-color: var(--cf-badge-color-secondary, hsl(0, 0%, 96%));
      color: var(--cf-badge-color-secondary-foreground, hsl(0, 0%, 9%));
    }

    .badge.destructive {
      background-color: var(--cf-badge-color-destructive, hsl(0, 100%, 50%));
      color: var(--cf-badge-color-destructive-foreground, hsl(0, 0%, 100%));
    }

    .badge.outline {
      background-color: transparent;
      border-color: var(--cf-badge-color-border, hsl(0, 0%, 89%));
      color: var(--cf-badge-color-text, hsl(0, 0%, 9%));
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
      outline: 2px solid var(--cf-badge-color-ring, hsl(212, 100%, 47%));
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

    // Emit cf-remove event
    this.emit("cf-remove", {
      variant: this.variant,
    });
  }
}

globalThis.customElements.define("cf-badge", CFBadge);
