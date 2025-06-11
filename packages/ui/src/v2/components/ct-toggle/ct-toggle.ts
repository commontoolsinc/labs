import { css, html, PropertyValues, unsafeCSS } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { BaseElement } from "../../core/base-element.ts";
import { toggleStyles } from "./styles.ts";

/**
 * CTToggle - Toggle button that can be pressed/unpressed with multiple variants and sizes
 *
 * @element ct-toggle
 *
 * @attr {boolean} pressed - Whether the toggle is pressed
 * @attr {boolean} disabled - Whether the toggle is disabled
 * @attr {string} variant - Visual style variant: "default" | "outline"
 * @attr {string} size - Toggle size: "default" | "sm" | "lg"
 * @attr {string} value - Value attribute for use in toggle groups
 *
 * @slot - Default slot for toggle content
 *
 * @fires ct-change - Fired on toggle with detail: { pressed }
 *
 * @example
 * <ct-toggle pressed>Bold</ct-toggle>
 */
export type ToggleVariant = "default" | "outline";
export type ToggleSize = "default" | "sm" | "lg";

export class CTToggle extends BaseElement {
  static override properties = {
    pressed: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
    variant: { type: String },
    size: { type: String },
    ariaLabel: { type: String, attribute: "aria-label" },
  };
  static override styles = unsafeCSS(toggleStyles);

  declare pressed: boolean;
  declare disabled: boolean;
  declare variant: ToggleVariant;
  declare size: ToggleSize;
  declare ariaLabel: string;

  private _buttonElement: HTMLButtonElement | null = null;

  constructor() {
    super();
    this.pressed = false;
    this.disabled = false;
    this.variant = "default";
    this.size = "default";
    this.ariaLabel = "";
  }

  get buttonElement(): HTMLButtonElement | null {
    if (!this._buttonElement) {
      this._buttonElement =
        this.shadowRoot?.querySelector("button") as HTMLButtonElement || null;
    }
    return this._buttonElement;
  }

  override updated(changedProperties: PropertyValues) {
    if (changedProperties.has("pressed")) {
      const oldValue = changedProperties.get("pressed");
      this.setAttribute("aria-pressed", this.pressed ? "true" : "false");
      if (oldValue !== undefined) {
        this.emit("ct-change", { pressed: this.pressed });
      }
    }
    if (changedProperties.has("disabled")) {
      this.setAttribute("aria-disabled", this.disabled ? "true" : "false");
      this.setAttribute("tabindex", this.disabled ? "-1" : "0");
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    // Set ARIA attributes
    this.setAttribute("role", "button");
    this.setAttribute("aria-pressed", this.pressed ? "true" : "false");
    if (this.disabled) {
      this.setAttribute("aria-disabled", "true");
    }
    this.setAttribute("tabindex", this.disabled ? "-1" : "0");

    // Add event listeners
    this.addEventListener("click", this.handleClick);
    this.addEventListener("keydown", this.handleKeydown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    // Clean up event listeners
    this.removeEventListener("click", this.handleClick);
    this.removeEventListener("keydown", this.handleKeydown);
  }

  override render() {
    const classes = {
      toggle: true,
      [`variant-${this.variant}`]: true,
      [`size-${this.size}`]: true,
      pressed: this.pressed,
    };

    return html`
      <button
        type="button"
        class="${classMap(classes)}"
        ?disabled="${this.disabled}"
        aria-pressed="${this.pressed ? "true" : "false"}"
        aria-label="${this.ariaLabel || ""}"
        part="toggle"
      >
        <slot></slot>
      </button>
    `;
  }

  private handleClick = (event: Event): void => {
    if (this.disabled) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Toggle the pressed state
    this.pressed = !this.pressed;
  };

  private handleKeydown = (event: KeyboardEvent): void => {
    if (this.disabled) return;

    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      this.pressed = !this.pressed;
    }
  };

  /**
   * Toggle the pressed state programmatically
   */
  toggle(): void {
    if (!this.disabled) {
      this.pressed = !this.pressed;
    }
  }

  /**
   * Focus the toggle programmatically
   */
  override focus(): void {
    this.buttonElement?.focus();
  }

  /**
   * Blur the toggle programmatically
   */
  override blur(): void {
    this.buttonElement?.blur();
  }
}

globalThis.customElements.define("ct-toggle", CTToggle);
