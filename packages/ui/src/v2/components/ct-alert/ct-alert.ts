import { css, html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTAlert - Alert message display component with variants and dismissible option
 *
 * @element ct-alert
 *
 * @attr {string} variant - Visual style variant: "default" | "destructive" | "warning" | "success" | "info"
 * @attr {boolean} dismissible - Whether the alert can be dismissed with an X button
 *
 * @slot icon - Alert icon
 * @slot title - Alert title
 * @slot description - Alert description
 * @slot - Default slot for alert content
 *
 * @fires ct-dismiss - Fired when alert is dismissed
 *
 * @example
 * <ct-alert variant="destructive" dismissible>
 *   <span slot="icon">⚠️</span>
 *   <h4 slot="title">Error</h4>
 *   <p slot="description">Something went wrong</p>
 * </ct-alert>
 */

export type AlertVariant =
  | "default"
  | "destructive"
  | "warning"
  | "success"
  | "info";

export class CTAlert extends BaseElement {
  static override styles = css`
    :host {
      /* Default color values if not provided */
      --ct-alert-color-background: var(--ct-theme-color-background, #ffffff);
      --ct-alert-color-foreground: var(--ct-theme-color-text, #0f172a);
      --ct-alert-color-muted: var(--ct-theme-color-surface, #f8fafc);
      --ct-alert-color-muted-foreground: var(
        --ct-theme-color-text-muted,
        #64748b
      );
      --ct-alert-color-primary: var(--ct-theme-color-primary, #0f172a);
      --ct-alert-color-primary-foreground: var(
        --ct-theme-color-primary-foreground,
        #f8fafc
      );
      --ct-alert-color-destructive: var(--ct-theme-color-error, #dc2626);
      --ct-alert-color-destructive-foreground: var(
        --ct-theme-color-error-foreground,
        #fef2f2
      );
      --ct-alert-color-warning: var(--ct-theme-color-warning, #f59e0b);
      --ct-alert-color-warning-foreground: var(
        --ct-theme-color-warning-foreground,
        #451a03
      );
      --ct-alert-color-success: var(--ct-theme-color-success, #10b981);
      --ct-alert-color-success-foreground: var(
        --ct-theme-color-success-foreground,
        #f0fdf4
      );
      --ct-alert-color-info: var(--ct-theme-color-primary, #3b82f6);
      --ct-alert-color-info-foreground: var(
        --ct-theme-color-primary-foreground,
        #eff6ff
      );
      --ct-alert-color-border: var(--ct-theme-color-border, #e2e8f0);
      --ct-alert-color-ring: var(--ct-theme-color-primary, #94a3b8);

      display: block;
    }

    .alert {
      position: relative;
      display: flex;
      border-radius: 0.5rem;
      border: 1px solid;
      padding: 1rem;
      gap: 0.75rem;
      font-family: inherit;
      transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
    }

    /* Alert icon */
    .alert-icon {
      flex-shrink: 0;
      width: 1rem;
      height: 1rem;
    }

    .alert-icon:empty {
      display: none;
    }

    /* Alert content */
    .alert-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
    }

    /* Alert title */
    .alert-title {
      font-size: 0.875rem;
      font-weight: 500;
      line-height: 1;
      letter-spacing: -0.025em;
    }

    .alert-title:empty {
      display: none;
    }

    /* Alert description */
    .alert-description {
      font-size: 0.875rem;
      line-height: 1.5;
      opacity: 0.9;
    }

    .alert-description:empty {
      display: none;
    }

    /* Dismiss button */
    .dismiss-button {
      all: unset;
      box-sizing: border-box;
      position: absolute;
      right: 0.5rem;
      top: 0.5rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      opacity: 0.7;
      transition: opacity 150ms cubic-bezier(0.4, 0, 0.2, 1);
      border-radius: 0.25rem;
      padding: 0.25rem;
      width: 1.5rem;
      height: 1.5rem;
    }

    .dismiss-button:hover {
      opacity: 1;
    }

    .dismiss-button:focus-visible {
      outline: 2px solid transparent;
      outline-offset: 2px;
      box-shadow: 0 0 0 2px var(--ct-alert-color-ring, #94a3b8);
    }

    .dismiss-button svg {
      width: 1rem;
      height: 1rem;
    }

    /* Default variant */
    .alert.variant-default {
      background-color: var(--ct-alert-color-background, #ffffff);
      color: var(--ct-alert-color-foreground, #0f172a);
      border-color: var(--ct-alert-color-border, #e2e8f0);
    }

    .alert.variant-default .alert-icon {
      color: var(--ct-alert-color-foreground, #0f172a);
    }

    /* Destructive variant */
    .alert.variant-destructive {
      background-color: var(--ct-alert-color-destructive-foreground, #fef2f2);
      color: var(--ct-alert-color-destructive, #dc2626);
      border-color: var(--ct-alert-color-destructive, #dc2626);
    }

    .alert.variant-destructive .alert-icon {
      color: var(--ct-alert-color-destructive, #dc2626);
    }

    .alert.variant-destructive .alert-title {
      color: var(--ct-alert-color-destructive, #dc2626);
    }

    .alert.variant-destructive .alert-description {
      color: var(--ct-alert-color-destructive, #dc2626);
      opacity: 0.8;
    }

    /* Warning variant */
    .alert.variant-warning {
      background-color: var(--ct-alert-color-warning-foreground, #fef3c7);
      color: var(--ct-alert-color-warning-foreground, #451a03);
      border-color: var(--ct-alert-color-warning, #f59e0b);
    }

    .alert.variant-warning .alert-icon {
      color: var(--ct-alert-color-warning, #f59e0b);
    }

    .alert.variant-warning .alert-title {
      color: var(--ct-alert-color-warning-foreground, #451a03);
    }

    .alert.variant-warning .alert-description {
      color: var(--ct-alert-color-warning-foreground, #451a03);
      opacity: 0.8;
    }

    /* Success variant */
    .alert.variant-success {
      background-color: var(--ct-alert-color-success-foreground, #f0fdf4);
      color: var(--ct-alert-color-success, #10b981);
      border-color: var(--ct-alert-color-success, #10b981);
    }

    .alert.variant-success .alert-icon {
      color: var(--ct-alert-color-success, #10b981);
    }

    .alert.variant-success .alert-title {
      color: var(--ct-alert-color-success, #10b981);
    }

    .alert.variant-success .alert-description {
      color: var(--ct-alert-color-success, #10b981);
      opacity: 0.8;
    }

    /* Info variant */
    .alert.variant-info {
      background-color: var(--ct-alert-color-info-foreground, #eff6ff);
      color: var(--ct-alert-color-info, #3b82f6);
      border-color: var(--ct-alert-color-info, #3b82f6);
    }

    .alert.variant-info .alert-icon {
      color: var(--ct-alert-color-info, #3b82f6);
    }

    .alert.variant-info .alert-title {
      color: var(--ct-alert-color-info, #3b82f6);
    }

    .alert.variant-info .alert-description {
      color: var(--ct-alert-color-info, #3b82f6);
      opacity: 0.8;
    }

    /* Slot styles */
    ::slotted(*) {
      margin: 0;
    }

    ::slotted([slot="icon"]) {
      width: 1rem;
      height: 1rem;
    }

    /* Adjust padding when dismissible */
    :host([dismissible]) .alert {
      padding-right: 2.5rem;
    }
  `;

  static override properties = {
    variant: { type: String },
    dismissible: { type: Boolean, reflect: true },
  };

  declare variant: AlertVariant;
  declare dismissible: boolean;

  constructor() {
    super();
    this.variant = "default";
    this.dismissible = false;
  }

  override render() {
    const classes = {
      alert: true,
      [`variant-${this.variant}`]: true,
    };

    return html`
      <div
        class="${classMap(classes)}"
        part="alert"
        role="alert"
      >
        <div class="alert-icon" part="icon">
          <slot name="icon"></slot>
        </div>
        <div class="alert-content">
          <div class="alert-title" part="title">
            <slot name="title"></slot>
          </div>
          <div class="alert-description" part="description">
            <slot name="description"></slot>
          </div>
          <slot></slot>
        </div>
        ${this.dismissible
          ? html`
            <button
              type="button"
              class="dismiss-button"
              part="dismiss-button"
              aria-label="Dismiss alert"
              @click="${this._handleDismiss}"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
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

  private _handleDismiss = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();

    // Emit ct-dismiss event
    this.emit("ct-dismiss", {
      variant: this.variant,
    });
  };
}

globalThis.customElements.define("ct-alert", CTAlert);
