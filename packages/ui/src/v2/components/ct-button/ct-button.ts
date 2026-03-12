import { html } from "lit";
import { styles } from "./styles.ts";
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
  | "link"
  | "pill";

export type ButtonSize = "default" | "sm" | "lg" | "icon";

export class CTButton extends BaseElement {
  static override styles = [BaseElement.baseStyles, styles];

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

    // Suppress click events on the host element when disabled.
    // JSX attaches onClick handlers to the host element, but click events
    // cross the shadow boundary and would fire even when disabled.
    this.addEventListener(
      "click",
      (e) => {
        if (this.disabled) {
          e.stopImmediatePropagation();
        }
      },
      { capture: true },
    );
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
    const classes: { [key: string]: true } = {
      button: true,
    };
    if (typeof this.variant === "string" && this.variant) {
      classes[this.variant] = true;
    }
    if (typeof this.size === "string" && this.size) classes[this.size] = true;

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

    // For submit/reset types, we need to manually find the ancestor ct-form
    // because the native button in our shadow DOM can't find forms across
    // shadow DOM boundaries
    if (this.type === "submit" || this.type === "reset") {
      const ctForm = this.closest("ct-form") as
        | (Element & { submit(): void; reset(): void })
        | null;
      if (ctForm) {
        e.preventDefault(); // Prevent native form lookup (which would fail)
        if (this.type === "submit") {
          ctForm.submit();
        } else {
          ctForm.reset();
        }
      }
      // If no ct-form found, let native behavior try (might work with light DOM forms)
      return;
    }
  }
}

globalThis.customElements.define("ct-button", CTButton);
