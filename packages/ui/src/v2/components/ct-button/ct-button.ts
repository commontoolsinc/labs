import { css, html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { BaseElement } from "../../core/base-element.ts";

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
 * @fires ct-click - Fired on click with detail: { variant, size }
 *
 * @example
 * <ct-button variant="primary" size="lg">Click Me</ct-button>
 */

export type ButtonVariant =
  | "default"
  | "destructive"
  | "outline"
  | "secondary"
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
        border-radius: var(--ct-border-radius-md);
        font-size: var(--ct-font-size-sm);
        font-weight: var(--ct-font-weight-medium);
        line-height: 1.25rem;
        transition: all var(--ct-transition-duration-fast)
          var(--ct-transition-timing-ease);
        cursor: pointer;
        user-select: none;
        border: 1px solid transparent;
        outline: 2px solid transparent;
        outline-offset: 2px;
        background-color: transparent;
        background-image: none;
        text-transform: none;
        font-family: inherit;
        -webkit-appearance: button;
        text-decoration: none;
      }

      .button:focus-visible {
        outline: 2px solid var(--ring, var(--ct-colors-primary-500));
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
        padding: 0.5rem 1rem;
      }

      .button.sm {
        height: 2.25rem;
        padding: 0.25rem 0.75rem;
      }

      .button.lg {
        height: 2.75rem;
        padding: 0.5rem 2rem;
        font-size: var(--ct-font-size-base);
        line-height: 1.5rem;
      }

      .button.icon {
        height: 2.5rem;
        width: 2.5rem;
        padding: 0;
      }

      /* Variant styles */
      .button.default {
        background-color: var(--primary, var(--ct-colors-primary-500));
        color: var(--primary-foreground, #ffffff);
        border-color: var(--primary, var(--ct-colors-primary-500));
      }

      .button.default:hover:not(:disabled) {
        background-color: var(--primary-hover, var(--ct-colors-primary-600));
        border-color: var(--primary-hover, var(--ct-colors-primary-600));
      }

      .button.destructive {
        background-color: var(--destructive, var(--ct-colors-error));
        color: var(--destructive-foreground, #ffffff);
        border-color: var(--destructive, var(--ct-colors-error));
      }

      .button.destructive:hover:not(:disabled) {
        background-color: var(--destructive-hover, #dc2626);
        border-color: var(--destructive-hover, #dc2626);
      }

      .button.outline {
        border-color: var(--border, var(--ct-colors-gray-300));
        background-color: transparent;
        color: var(--foreground, var(--ct-colors-gray-900));
      }

      .button.outline:hover:not(:disabled) {
        background-color: var(--accent, var(--ct-colors-gray-100));
      }

      .button.secondary {
        background-color: var(--secondary, var(--ct-colors-gray-100));
        color: var(--secondary-foreground, var(--ct-colors-gray-900));
        border-color: var(--secondary, var(--ct-colors-gray-100));
      }

      .button.secondary:hover:not(:disabled) {
        background-color: var(--secondary-hover, var(--ct-colors-gray-200));
        border-color: var(--secondary-hover, var(--ct-colors-gray-200));
      }

      .button.ghost {
        color: var(--foreground, var(--ct-colors-gray-900));
      }

      .button.ghost:hover:not(:disabled) {
        background-color: var(--accent, var(--ct-colors-gray-100));
      }

      .button.link {
        color: var(--primary, var(--ct-colors-primary-500));
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
  };

  declare variant: ButtonVariant;
  declare size: ButtonSize;
  declare disabled: boolean;
  declare type: "button" | "submit" | "reset";

  constructor() {
    super();
    this.variant = "default";
    this.size = "default";
    this.disabled = false;
    this.type = "button";
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

    // Emit custom event
    this.emit("ct-click", {
      variant: this.variant,
      size: this.size,
    });
  }
}

globalThis.customElements.define("ct-button", CTButton);
