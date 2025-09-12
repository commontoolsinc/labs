import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { consume } from "@lit/context";
import { BaseElement } from "../../core/base-element.ts";
import {
  applyThemeToElement,
  type CTTheme,
  defaultTheme,
  themeContext,
} from "../theme-context.ts";

/**
 * CTButton - Interactive button element with multiple variants and sizes
 *
 * @element ct-button
 *
 * @attr {string} variant - Visual style variant: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link"
 * @attr {string} size - Button size: "default" | "sm" | "lg" | "icon"
 * @attr {boolean} disabled - Whether the button is disabled
 * @attr {string} type - Button type: "button" | "submit" | "reset"
 *
 * @slot - Default slot for button content
 *
 * @example
 * <ct-button variant="primary" size="lg" @click=${() => console.log('Button clicked')}>Click Me</ct-button>
 */

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "destructive"
  | "outline"
  | "ghost"
  | "link";

export type ButtonSize = "default" | "sm" | "lg" | "icon";

export class CTButton extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: inline-block;
        outline: none;
        box-sizing: border-box;
      }

      *,
      *::before,
      *::after {
        box-sizing: inherit;
      }

      .button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        white-space: nowrap;
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-md, 0.375rem)
        );
        font-size: 0.875rem;
        font-weight: 500;
        font-family: var(--ct-theme-font-family, inherit);
        line-height: 1.25rem;
        transition: all var(--ct-theme-animation-duration, 0.2s) ease;
        cursor: pointer;
        user-select: none;
        border: 1px solid transparent;
        outline: 2px solid transparent;
        outline-offset: 2px;
        background-color: transparent;
        background-image: none;
        text-transform: none;
        -webkit-appearance: button;
        text-decoration: none;
      }

      .button:focus-visible {
        outline: 2px solid
          var(--ct-theme-color-primary, var(--ct-color-primary, #3b82f6));
        outline-offset: 2px;
      }

      .button:disabled {
        pointer-events: none;
        opacity: 0.5;
        cursor: not-allowed;
      }

      /* Size variants */
      .button.default {
        height: 2.5rem;
        padding: var(--ct-theme-spacing-normal, 0.5rem)
          var(--ct-theme-spacing-loose, 1rem);
        }

        .button.sm {
          height: 2.25rem;
          padding: var(--ct-theme-spacing-tight, 0.25rem)
            var(--ct-theme-spacing-normal, 0.75rem);
          font-size: 0.75rem;
        }

        .button.lg {
          height: 2.75rem;
          padding: var(--ct-theme-spacing-normal, 0.5rem)
            var(--ct-theme-spacing-loose, 2rem);
          font-size: 1rem;
          line-height: 1.5rem;
        }

        .button.icon {
          height: 2.5rem;
          width: 2.5rem;
          padding: 0;
        }

        .button.md {
          height: 2rem;
          padding: var(--ct-theme-spacing-tight, 0.25rem)
            var(--ct-theme-spacing-normal, 0.75rem);
          font-size: 0.75rem;
        }

        /* Variant styles */
        .button.primary {
          background-color: var(
            --ct-theme-color-primary,
            var(--ct-color-primary, #3b82f6)
          );
          color: var(
            --ct-theme-color-primary-foreground,
            var(--ct-color-white, #ffffff)
          );
          border-color: var(
            --ct-theme-color-primary,
            var(--ct-color-primary, #3b82f6)
          );
        }

        .button.primary:hover:not(:disabled) {
          opacity: 0.9;
          transform: translateY(-1px);
        }

        .button.primary:active:not(:disabled) {
          transform: translateY(0);
        }

        .button.destructive {
          background-color: var(
            --ct-theme-color-error,
            var(--ct-color-red-600, #dc2626)
          );
          color: var(
            --ct-theme-color-error-foreground,
            var(--ct-color-white, #ffffff)
          );
          border-color: var(--ct-theme-color-error, var(--ct-color-red-600, #dc2626));
        }

        .button.destructive:hover:not(:disabled) {
          opacity: 0.9;
        }

        .button.outline {
          border-color: var(
            --ct-theme-color-border,
            var(--ct-color-gray-300, #d1d5db)
          );
          background-color: transparent;
          color: var(--ct-theme-color-text, var(--ct-color-gray-900, #111827));
        }

        .button.outline:hover:not(:disabled) {
          background-color: var(
            --ct-theme-color-surface,
            var(--ct-color-gray-50, #f9fafb)
          );
        }

        .button.secondary {
          background-color: var(
            --ct-theme-color-secondary,
            var(--ct-color-gray-100, #f3f4f6)
          );
          color: var(
            --ct-theme-color-secondary-foreground,
            var(--ct-color-gray-900, #111827)
          );
          border-color: var(
            --ct-theme-color-secondary,
            var(--ct-color-gray-100, #f3f4f6)
          );
        }

        .button.secondary:hover:not(:disabled) {
          background-color: var(
            --ct-theme-color-surface-hover,
            var(--ct-color-gray-200, #e5e7eb)
          );
          border-color: var(
            --ct-theme-color-surface-hover,
            var(--ct-color-gray-200, #e5e7eb)
          );
        }

        .button.ghost {
          color: var(--ct-theme-color-text, var(--ct-color-gray-700, #374151));
        }

        .button.ghost:hover:not(:disabled) {
          background-color: var(
            --ct-theme-color-surface-hover,
            var(--ct-color-gray-100, #f3f4f6)
          );
        }

        .button.link {
          color: var(--ct-theme-color-primary, var(--ct-color-primary, #3b82f6));
          text-underline-offset: 4px;
        }

        .button.link:hover:not(:disabled) {
          text-decoration: underline;
        }
      `,
    ];

    static override properties = {
      variant: { type: String },
      size: { type: String },
      disabled: { type: Boolean, reflect: true },
      type: { type: String },
      theme: { type: Object, attribute: false },
    };

    declare variant: ButtonVariant;
    declare size: ButtonSize;
    declare disabled: boolean;
    declare type: "button" | "submit" | "reset";

    @consume({ context: themeContext, subscribe: true })
    @property({ attribute: false })
    declare theme?: CTTheme;

    constructor() {
      super();
      this.variant = "primary";
      this.size = "default";
      this.disabled = false;
      this.type = "button";
    }

    override firstUpdated(
      changedProperties: Map<string | number | symbol, unknown>,
    ) {
      super.firstUpdated(changedProperties);
      this._updateThemeProperties();
    }

    override updated(
      changedProperties: Map<string | number | symbol, unknown>,
    ) {
      super.updated(changedProperties);
      if (changedProperties.has("theme")) {
        this._updateThemeProperties();
      }
    }

    private _updateThemeProperties() {
      const currentTheme = this.theme || defaultTheme;
      applyThemeToElement(this, currentTheme);
    }

    override render() {
      const classes = {
        button: true,
        [this.variant]: true,
        [this.size]: true,
      };

      return html`
        <button
          class="${classMap(classes)}"
          ?disabled="${this.disabled}"
          type="${this.type}"
          @click="${this._handleClick}"
          part="button"
          data-ct-button
        >
          <slot></slot>
        </button>
      `;
    }

    private _handleClick(e: Event) {
      if (this.disabled) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // For non-button types, let the browser handle it
      if (this.type !== "button") {
        return;
      }
    }
  }

  globalThis.customElements.define("ct-button", CTButton);
