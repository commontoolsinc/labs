import { html, LitElement, PropertyValues, unsafeCSS } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { BaseElement } from "../../core/base-element.ts";
import { toggleStyles } from "./styles.ts";

/** @deprecated Use ComponentSize instead */
export type ToggleSize = "sm" | "md" | "lg";

/**
 * CFToggle - Toggle button that can be pressed/unpressed with multiple variants and sizes
 *
 * @element cf-toggle
 *
 * @attr {boolean} pressed - Whether the toggle is pressed
 * @attr {boolean} disabled - Whether the toggle is disabled
 * @attr {string} variant - Visual style variant: "default" | "outline"
 * @attr {string} size - Toggle size: "sm" | "md" | "lg" (default: "md")
 * @attr {string} value - Value attribute for use in toggle groups
 *
 * @slot - Default slot for toggle content
 *
 * @fires cf-change - Fired on toggle with detail: { pressed }
 *
 * @example
 * <cf-toggle pressed>Bold</cf-toggle>
 */
export type ToggleVariant = "default" | "outline";

export class CFToggle extends BaseElement {
  static override shadowRootOptions = {
    ...LitElement.shadowRootOptions,
    delegatesFocus: true,
  };

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
  declare size: "sm" | "md" | "lg";
  declare ariaLabel: string;

  private _buttonElement: HTMLButtonElement | null = null;

  constructor() {
    super();
    this.pressed = false;
    this.disabled = false;
    this.variant = "default";
    this.size = "md";
    this.ariaLabel = "";
    this.setAttribute("exportparts", "toggle");
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
      if (oldValue !== undefined) {
        this.emit("cf-change", { pressed: this.pressed });
      }
    }
    if (changedProperties.has("pressed") || changedProperties.has("disabled")) {
      this._updateAriaAttributes();
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    // Set ARIA role and initial attributes
    this.setAttribute("role", "button");
    this._updateAriaAttributes();

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

  private _updateAriaAttributes(): void {
    this.setAttribute("aria-pressed", this.pressed ? "true" : "false");
    this.setAttribute("aria-disabled", this.disabled ? "true" : "false");
    this.tabIndex = this.disabled ? -1 : 0;
  }

  override render() {
    const classes = {
      toggle: true,
      [`variant-${this.variant}`]: true,
      [`size-${this.size}`]: true,
      pressed: this.pressed,
    };

    return html`
      <!-- aria-hidden and tabindex="-1" prevent the inner button from creating a
        duplicate interactive role — the host element already exposes role="button"
        with all ARIA attributes to the accessibility tree. -->
      <button
        type="button"
        class="${classMap(classes)}"
        ?disabled="${this.disabled}"
        aria-hidden="true"
        tabindex="-1"
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

globalThis.customElements.define("cf-toggle", CFToggle);
