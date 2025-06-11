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
      display: block;

      /* Default color values if not provided */
      --background: #ffffff;
      --foreground: #0f172a;
      --muted: #f8fafc;
      --muted-foreground: #64748b;
      --primary: #0f172a;
      --primary-foreground: #f8fafc;
      --destructive: #dc2626;
      --destructive-foreground: #fef2f2;
      --warning: #f59e0b;
      --warning-foreground: #451a03;
      --success: #10b981;
      --success-foreground: #f0fdf4;
      --info: #3b82f6;
      --info-foreground: #eff6ff;
      --border: #e2e8f0;
      --ring: #94a3b8;
    }

    .alert {
      position: relative;
      display: flex;
      width: 100%;
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
      box-shadow: 0 0 0 2px var(--ring, #94a3b8);
    }

    .dismiss-button svg {
      width: 1rem;
      height: 1rem;
    }

    /* Default variant */
    .alert.variant-default {
      background-color: var(--background, #ffffff);
      color: var(--foreground, #0f172a);
      border-color: var(--border, #e2e8f0);
    }

    .alert.variant-default .alert-icon {
      color: var(--foreground, #0f172a);
    }

    /* Destructive variant */
    .alert.variant-destructive {
      background-color: var(--destructive-foreground, #fef2f2);
      color: var(--destructive, #dc2626);
      border-color: var(--destructive, #dc2626);
    }

    .alert.variant-destructive .alert-icon {
      color: var(--destructive, #dc2626);
    }

    .alert.variant-destructive .alert-title {
      color: var(--destructive, #dc2626);
    }

    .alert.variant-destructive .alert-description {
      color: var(--destructive, #dc2626);
      opacity: 0.8;
    }

    /* Warning variant */
    .alert.variant-warning {
      background-color: #fef3c7;
      color: var(--warning-foreground, #451a03);
      border-color: var(--warning, #f59e0b);
    }

    .alert.variant-warning .alert-icon {
      color: var(--warning, #f59e0b);
    }

    .alert.variant-warning .alert-title {
      color: var(--warning-foreground, #451a03);
    }

    .alert.variant-warning .alert-description {
      color: var(--warning-foreground, #451a03);
      opacity: 0.8;
    }

    /* Success variant */
    .alert.variant-success {
      background-color: var(--success-foreground, #f0fdf4);
      color: #065f46;
      border-color: var(--success, #10b981);
    }

    .alert.variant-success .alert-icon {
      color: var(--success, #10b981);
    }

    .alert.variant-success .alert-title {
      color: #065f46;
    }

    .alert.variant-success .alert-description {
      color: #065f46;
      opacity: 0.8;
    }

    /* Info variant */
    .alert.variant-info {
      background-color: var(--info-foreground, #eff6ff);
      color: #1e3a8a;
      border-color: var(--info, #3b82f6);
    }

    .alert.variant-info .alert-icon {
      color: var(--info, #3b82f6);
    }

    .alert.variant-info .alert-title {
      color: #1e3a8a;
    }

    .alert.variant-info .alert-description {
      color: #1e3a8a;
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
