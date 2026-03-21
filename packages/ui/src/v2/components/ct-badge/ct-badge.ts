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
      --ct-badge-color-primary: var(--ct-theme-color-primary, #2d8c3c);
      --ct-badge-color-primary-foreground: var(
        --ct-theme-color-primary-foreground,
        #ffffff
      );
      --ct-badge-color-secondary: var(--ct-theme-color-surface, #f3f1eb);
      --ct-badge-color-secondary-foreground: var(
        --ct-theme-color-text,
        #2c3227
      );
      --ct-badge-color-destructive: var(--ct-theme-color-error, #c44536);
      --ct-badge-color-destructive-foreground: var(
        --ct-theme-color-error-foreground,
        #ffffff
      );
      --ct-badge-color-border: var(--ct-theme-color-border, #d4d2c8);
      --ct-badge-color-text: var(--ct-theme-color-text, #2c3227);
      --ct-badge-color-ring: var(--ct-theme-color-primary, #2d8c3c);

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
      padding: 0.1875rem 0.625rem;
      font-size: 0.75rem;
      font-weight: 700;
      line-height: 1;
      border-radius: 9999px;
      border: 1.5px solid transparent;
      transition: all 150ms cubic-bezier(0.25, 0.1, 0.25, 1);
      -webkit-font-smoothing: antialiased;
      font-family: var(--ct-theme-font-family, inherit);
    }

    /* Variant styles */
    .badge.default {
      background-color: var(--ct-badge-color-primary, #2d8c3c);
      color: var(--ct-badge-color-primary-foreground, #ffffff);
    }

    .badge.secondary {
      background-color: var(--ct-badge-color-secondary, #f3f1eb);
      color: var(--ct-badge-color-secondary-foreground, #2c3227);
    }

    .badge.destructive {
      background-color: var(--ct-badge-color-destructive, #c44536);
      color: var(--ct-badge-color-destructive-foreground, #ffffff);
    }

    .badge.outline {
      background-color: transparent;
      border-color: var(--ct-badge-color-border, #d4d2c8);
      color: var(--ct-badge-color-text, #2c3227);
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
      opacity: 0.5;
      transition: opacity 150ms;
      color: currentColor;
    }

    .close-button:hover {
      opacity: 1;
    }

    .close-button:focus-visible {
      outline: none;
      box-shadow:
        0 0 0 2px var(--ct-theme-color-background, #fdfcf9),
        0 0 0 4px var(--ct-badge-color-ring, #2d8c3c);
      border-radius: 50%;
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
