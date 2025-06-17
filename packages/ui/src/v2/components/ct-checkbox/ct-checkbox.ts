import { css, html } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTCheckbox - Binary selection input with support for indeterminate state
 *
 * @element ct-checkbox
 *
 * @attr {boolean} checked - Whether the checkbox is checked
 * @attr {boolean} disabled - Whether the checkbox is disabled
 * @attr {string} name - Name attribute for form submission
 * @attr {string} value - Value attribute for form submission
 * @attr {boolean} required - Whether the checkbox is required
 * @attr {boolean} indeterminate - Whether the checkbox is in indeterminate state
 *
 * @slot - Default slot for checkbox label text
 *
 * @fires ct-change - Fired on change with detail: { checked, indeterminate }
 *
 * @example
 * <ct-checkbox name="terms" checked>Accept terms</ct-checkbox>
 */

export class CTCheckbox extends BaseElement {
  static override styles = css`
    :host {
      display: inline-block;
      position: relative;
      cursor: pointer;
      line-height: 0;

      /* Default color values if not provided */
      --background: #ffffff;
      --foreground: #0f172a;
      --primary: #0f172a;
      --primary-foreground: #f8fafc;
      --border: #e2e8f0;
      --ring: #94a3b8;
    }

    :host([disabled]) {
      cursor: not-allowed;
      opacity: 0.5;
    }

    :host:focus {
      outline: none;
    }

    :host:focus-visible .checkbox {
      outline: 2px solid transparent;
      outline-offset: 2px;
      box-shadow:
        0 0 0 2px var(--background, #fff),
        0 0 0 4px var(--ring, #94a3b8);
    }

    .checkbox {
      position: relative;
      width: 1rem; /* size-4 */
      height: 1rem; /* size-4 */
      border: 1px solid var(--primary, #0f172a);
      border-radius: 0.25rem; /* rounded */
      background-color: var(--background, #fff);
      transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .checkbox.checked,
    .checkbox.indeterminate {
      background-color: var(--primary, #0f172a);
      border-color: var(--primary, #0f172a);
    }

    .checkbox.disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }

    /* Checkmark using CSS transforms */
    .checkmark {
      display: none;
      width: 10px;
      height: 6px;
      position: relative;
    }

    .checkbox.checked .checkmark {
      display: block;
    }

    .checkbox.checked .checkmark::after {
      content: "";
      position: absolute;
      left: 0;
      top: 2px;
      width: 4px;
      height: 7px;
      border: solid var(--primary-foreground, #f8fafc);
      border-width: 0 2px 2px 0;
      transform: rotate(45deg);
    }

    /* Indeterminate state - horizontal line */
    .checkbox.indeterminate .checkmark {
      display: block;
      width: 8px;
      height: 2px;
      background-color: var(--primary-foreground, #f8fafc);
    }

    .checkbox.indeterminate .checkmark::after {
      display: none;
    }

    /* Hidden native input for form compatibility */
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border-width: 0;
    }

    /* Hover state */
    :host(:not([disabled]):hover) .checkbox:not(.checked):not(.indeterminate) {
      border-color: var(--primary, #0f172a);
    }

    /* Animation for checkmark */
    .checkbox.checked .checkmark::after {
      animation: checkmark-animation 200ms ease-out;
    }

    @keyframes checkmark-animation {
      0% {
        transform: rotate(45deg) scale(0);
      }
      100% {
        transform: rotate(45deg) scale(1);
      }
    }
  `;

  static override properties = {
    checked: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
    indeterminate: { type: Boolean, reflect: true },
    name: { type: String },
    value: { type: String },
  };

  declare checked: boolean;
  declare disabled: boolean;
  declare indeterminate: boolean;
  declare name: string;
  declare value: string;

  constructor() {
    super();
    this.checked = false;
    this.disabled = false;
    this.indeterminate = false;
    this.name = "";
    this.value = "on";
  }

  override connectedCallback() {
    super.connectedCallback();
    // Make the element focusable
    this.tabIndex = this.disabled ? -1 : 0;
    this.setAttribute("role", "checkbox");
    this._updateAriaAttributes();
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);

    if (changedProperties.has("disabled")) {
      this.tabIndex = this.disabled ? -1 : 0;
    }

    if (
      changedProperties.has("checked") ||
      changedProperties.has("indeterminate") ||
      changedProperties.has("disabled")
    ) {
      this._updateAriaAttributes();
    }
  }

  override render() {
    const checkboxClasses = {
      "checkbox": true,
      "checked": this.checked && !this.indeterminate,
      "indeterminate": this.indeterminate,
      "disabled": this.disabled,
    };

    const classString = Object.entries(checkboxClasses)
      .filter(([_, value]) => value)
      .map(([key]) => key)
      .join(" ");

    return html`
      <div
        class="${classString}"
        part="checkbox"
        @click="${this._handleClick}"
        @keydown="${this._handleKeydown}"
      >
        <span class="checkmark" part="checkmark"></span>
      </div>
      <input
        type="checkbox"
        class="sr-only"
        ?checked="${this.checked}"
        ?disabled="${this.disabled}"
        name="${ifDefined(this.name || undefined)}"
        value="${this.value}"
        tabindex="-1"
        aria-hidden="true"
      />
    `;
  }

  private _updateAriaAttributes() {
    this.setAttribute(
      "aria-checked",
      this.indeterminate ? "mixed" : String(this.checked),
    );
    this.setAttribute("aria-disabled", String(this.disabled));
  }

  private _handleClick(event: Event) {
    if (this.disabled) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Toggle checked state
    const oldChecked = this.checked;
    this.checked = !this.checked;

    // Clear indeterminate state when clicked
    if (this.indeterminate) {
      this.indeterminate = false;
    }

    // Emit change event
    this.emit("ct-change", {
      checked: this.checked,
      indeterminate: this.indeterminate,
    });
  }

  private _handleKeydown(event: KeyboardEvent) {
    if (this.disabled) {
      return;
    }

    // Handle Space key
    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      this._handleClick(event);
    }
  }

  /**
   * Focus the checkbox programmatically
   */
  override focus(): void {
    super.focus();
  }

  /**
   * Blur the checkbox programmatically
   */
  override blur(): void {
    super.blur();
  }
}

globalThis.customElements.define("ct-checkbox", CTCheckbox);
