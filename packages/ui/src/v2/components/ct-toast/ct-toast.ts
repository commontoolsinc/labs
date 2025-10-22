import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { consume } from "@lit/context";
import { classMap } from "lit/directives/class-map.js";
import { BaseElement } from "../../core/base-element.ts";
import {
  applyThemeToElement,
  type CTTheme,
  defaultTheme,
  themeContext,
} from "../theme-context.ts";

/**
 * CTToast - Individual toast notification component
 *
 * @element ct-toast
 *
 * @attr {string} variant - Visual style variant: "default" | "destructive" | "warning" | "success" | "info"
 * @attr {string} text - Toast message text
 * @attr {number} timestamp - Timestamp in milliseconds (for display or auto-dismiss)
 * @attr {boolean} dismissible - Whether the toast can be dismissed with an X button
 * @attr {string} action-label - Optional action button label
 *
 * @fires ct-dismiss - Fired when toast is dismissed
 * @fires ct-action - Fired when action button is clicked
 *
 * @example
 * <ct-toast variant="success" text="Item saved successfully" dismissible></ct-toast>
 *
 * @example
 * <ct-toast
 *   variant="info"
 *   text="New message received"
 *   action-label="View"
 * ></ct-toast>
 */

export type ToastVariant =
  | "default"
  | "destructive"
  | "warning"
  | "success"
  | "info";

export interface ToastNotification {
  id: string;
  variant?: ToastVariant;
  text: string;
  timestamp: number;
  actionLabel?: string;
}

export class CTToast extends BaseElement {
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

      .toast {
        position: relative;
        display: flex;
        align-items: center;
        width: 100%;
        min-width: 20rem;
        max-width: 28rem;
        border-radius: 0.5rem;
        border: 1px solid;
        padding: 1rem;
        gap: 0.75rem;
        font-family: inherit;
        font-size: 0.875rem;
        line-height: 1.5;
        box-shadow:
          0 10px 15px -3px rgb(0 0 0 / 0.1),
          0 4px 6px -4px rgb(0 0 0 / 0.1);
        transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
        animation: slideIn 200ms cubic-bezier(0.4, 0, 0.2, 1);
      }

      @keyframes slideIn {
        from {
          transform: translateX(100%);
          opacity: 0;
        }
        to {
          transform: translateX(0);
          opacity: 1;
        }
      }

      :host([dismissing]) .toast {
        animation: slideOut 200ms cubic-bezier(0.4, 0, 0.2, 1);
      }

      @keyframes slideOut {
        from {
          transform: translateX(0);
          opacity: 1;
        }
        to {
          transform: translateX(100%);
          opacity: 0;
        }
      }

      .toast-content {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }

      .toast-text {
        margin: 0;
      }

      .toast-timestamp {
        font-size: 0.75rem;
        opacity: 0.6;
      }

      .toast-actions {
        display: flex;
        gap: 0.5rem;
        align-items: center;
      }

      .action-button,
      .dismiss-button {
        all: unset;
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: opacity 150ms cubic-bezier(0.4, 0, 0.2, 1);
        border-radius: 0.25rem;
        padding: 0.25rem 0.5rem;
        font-size: 0.75rem;
        font-weight: 500;
      }

      .action-button {
        text-decoration: underline;
      }

      .action-button:hover {
        opacity: 0.8;
      }

      .dismiss-button {
        padding: 0.25rem;
        opacity: 0.7;
      }

      .dismiss-button:hover {
        opacity: 1;
      }

      .dismiss-button:focus-visible,
      .action-button:focus-visible {
        outline: 2px solid transparent;
        outline-offset: 2px;
        box-shadow: 0 0 0 2px
          var(
            --ct-theme-color-primary,
            var(--ct-color-primary, #3b82f6)
          );
        }

        .dismiss-button svg {
          width: 1rem;
          height: 1rem;
        }

        /* Default variant */
        .toast.variant-default {
          background-color: var(
            --ct-theme-color-background,
            var(--ct-color-background, #ffffff)
          );
          color: var(--ct-theme-color-text, var(--ct-color-text, #0f172a));
          border-color: var(--ct-theme-color-border, var(--ct-color-border, #e2e8f0));
        }

        /* Destructive variant */
        .toast.variant-destructive {
          background-color: var(
            --ct-theme-color-error-foreground,
            var(--ct-color-error-foreground, #fef2f2)
          );
          color: var(--ct-theme-color-error, var(--ct-color-error, #dc2626));
          border-color: var(--ct-theme-color-error, var(--ct-color-error, #dc2626));
        }

        /* Warning variant */
        .toast.variant-warning {
          background-color: var(
            --ct-theme-color-warning-foreground,
            var(--ct-color-warning-foreground, #fef3c7)
          );
          color: var(
            --ct-theme-color-warning,
            var(--ct-color-warning, #d97706)
          );
          border-color: var(
            --ct-theme-color-warning,
            var(--ct-color-warning, #d97706)
          );
        }

        /* Success variant */
        .toast.variant-success {
          background-color: var(
            --ct-theme-color-success-foreground,
            var(--ct-color-success-foreground, #f0fdf4)
          );
          color: var(
            --ct-theme-color-success,
            var(--ct-color-success, #16a34a)
          );
          border-color: var(
            --ct-theme-color-success,
            var(--ct-color-success, #16a34a)
          );
        }

        /* Info variant */
        .toast.variant-info {
          background-color: var(
            --ct-theme-color-primary-foreground,
            var(--ct-color-primary-foreground, #eff6ff)
          );
          color: var(
            --ct-theme-color-primary,
            var(--ct-color-primary, #3b82f6)
          );
          border-color: var(
            --ct-theme-color-primary,
            var(--ct-color-primary, #3b82f6)
          );
        }

        /* Adjust padding when dismissible */
        :host([dismissible]) .toast {
          padding-right: 1rem;
        }
      `,
    ];

    static override properties = {
      variant: { type: String },
      text: { type: String },
      timestamp: { type: Number },
      dismissible: { type: Boolean, reflect: true },
      actionLabel: { type: String, attribute: "action-label" },
      theme: { type: Object, attribute: false },
    };

    @consume({ context: themeContext, subscribe: true })
    @property({ attribute: false })
    declare theme?: CTTheme;

    @property({ type: String })
    declare variant: ToastVariant;

    @property({ type: String })
    declare text: string;

    @property({ type: Number })
    declare timestamp: number;

    @property({ type: Boolean, reflect: true })
    declare dismissible: boolean;

    @property({ type: String, attribute: "action-label" })
    declare actionLabel?: string;

    constructor() {
      super();
      this.variant = "default";
      this.text = "";
      this.timestamp = Date.now();
      this.dismissible = true;
    }

    override firstUpdated(changed: Map<string | number | symbol, unknown>) {
      super.firstUpdated(changed);
      this._updateThemeProperties();
    }

    override updated(changed: Map<string | number | symbol, unknown>) {
      super.updated(changed);
      if (changed.has("theme")) {
        this._updateThemeProperties();
      }
    }

    private _updateThemeProperties() {
      const currentTheme = this.theme || defaultTheme;
      applyThemeToElement(this, currentTheme);
    }

    override render() {
      const classes = {
        toast: true,
        [`variant-${this.variant}`]: true,
      };

      return html`
        <div class="${classMap(classes)}" part="toast" role="status">
          <div class="toast-content">
            <p class="toast-text" part="text">${this.text}</p>
            ${this._renderTimestamp()}
          </div>
          <div class="toast-actions">
            ${this.actionLabel
              ? html`
                <button
                  type="button"
                  class="action-button"
                  part="action-button"
                  @click="${this._handleAction}"
                >
                  ${this.actionLabel}
                </button>
              `
              : null} ${this.dismissible
              ? html`
                <button
                  type="button"
                  class="dismiss-button"
                  part="dismiss-button"
                  aria-label="Dismiss notification"
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
        </div>
      `;
    }

    private _renderTimestamp() {
      if (!this.timestamp) return null;

      const timeAgo = this._formatTimeAgo(this.timestamp);
      return html`
        <span class="toast-timestamp" part="timestamp">${timeAgo}</span>
      `;
    }

    private _formatTimeAgo(timestamp: number): string {
      const now = Date.now();
      const diff = now - timestamp;
      const seconds = Math.floor(diff / 1000);

      if (seconds < 60) return "just now";
      if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        return `${minutes}m ago`;
      }
      if (seconds < 86400) {
        const hours = Math.floor(seconds / 3600);
        return `${hours}h ago`;
      }
      const days = Math.floor(seconds / 86400);
      return `${days}d ago`;
    }

    private _handleDismiss = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();

      this.setAttribute("dismissing", "");

      setTimeout(() => {
        this.emit("ct-dismiss", {
          variant: this.variant,
          text: this.text,
          timestamp: this.timestamp,
        });
      }, 200);
    };

    private _handleAction = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();

      this.emit("ct-action", {
        variant: this.variant,
        text: this.text,
        timestamp: this.timestamp,
        actionLabel: this.actionLabel,
      });
    };
  }

  globalThis.customElements.define("ct-toast", CTToast);
