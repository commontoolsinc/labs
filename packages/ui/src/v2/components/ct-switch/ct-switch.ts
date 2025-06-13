import { css, html } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTSwitch - Toggle switch component for binary on/off states
 *
 * @element ct-switch
 *
 * @attr {boolean} checked - Whether the switch is checked/on
 * @attr {boolean} disabled - Whether the switch is disabled
 * @attr {string} name - Name attribute for form submission
 * @attr {string} value - Value attribute for form submission (default: "on")
 *
 * @fires ct-change - Fired when switch state changes with detail: { checked }
 *
 * @example
 * <ct-switch checked>Enable notifications</ct-switch>
 */

export class CTSwitch extends BaseElement {
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
      --input: #e2e8f0;
    }

    :host([disabled]) {
      cursor: not-allowed;
      opacity: 0.5;
    }

    :host:focus {
      outline: none;
    }

    :host:focus-visible .switch {
      outline: 2px solid transparent;
      outline-offset: 2px;
      box-shadow:
        0 0 0 2px var(--background, #fff),
        0 0 0 4px var(--ring, #94a3b8);
    }

    .switch {
      position: relative;
      width: 2rem; /* w-8 */
      height: 1.15rem; /* h-[1.15rem] */
      border-radius: 9999px; /* rounded-full */
      background-color: var(--input, #e2e8f0);
      transition: all 200ms cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      align-items: center;
    }

    .switch.checked {
      background-color: var(--primary, #0f172a);
    }

    .switch.disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }

    /* Thumb element */
    .thumb {
      position: absolute;
      left: 0.125rem; /* 2px */
      width: 0.875rem; /* 14px */
      height: 0.875rem; /* 14px */
      border-radius: 9999px;
      background-color: var(--background, #fff);
      transition: transform 200ms cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06);
    }

    .switch.checked .thumb {
      transform: translateX(0.875rem); /* 14px - move to the right */
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
    :host(:not([disabled]):hover) .switch:not(.checked) {
      background-color: var(--border, #e2e8f0);
    }

    :host(:not([disabled]):hover) .switch.checked {
      opacity: 0.9;
    }

    /* Animation for thumb */
    .thumb {
      will-change: transform;
    }

    /* Ensure smooth transition even when changing state rapidly */
    .switch,
    .thumb {
      -webkit-backface-visibility: hidden;
      backface-visibility: hidden;
      -webkit-perspective: 1000px;
      perspective: 1000px;
    }
  `;

  static override properties = {
    checked: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
    name: { type: String },
    value: { type: String },
  };

  declare checked: boolean;
  declare disabled: boolean;
  declare name: string;
  declare value: string;

  constructor() {
    super();
    this.checked = false;
    this.disabled = false;
    this.name = "";
    this.value = "on";
  }

  override connectedCallback() {
    super.connectedCallback();
    // Make the element focusable
    this.tabIndex = this.disabled ? -1 : 0;
    this.setAttribute("role", "switch");
    this._updateAriaAttributes();
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);

    if (changedProperties.has("disabled")) {
      this.tabIndex = this.disabled ? -1 : 0;
    }

    if (changedProperties.has("checked") || changedProperties.has("disabled")) {
      this._updateAriaAttributes();
    }
  }

  override render() {
    const switchClasses = {
      "switch": true,
      "checked": this.checked,
      "disabled": this.disabled,
    };

    const classString = Object.entries(switchClasses)
      .filter(([_, value]) => value)
      .map(([key]) => key)
      .join(" ");

    return html`
      <div
        class="${classString}"
        part="switch"
        @click="${this._handleClick}"
        @keydown="${this._handleKeydown}"
      >
        <span class="thumb" part="thumb"></span>
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
    this.setAttribute("aria-checked", String(this.checked));
    this.setAttribute("aria-disabled", String(this.disabled));
  }

  private _handleClick(event: Event) {
    if (this.disabled) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Toggle checked state
    this.checked = !this.checked;

    // Emit change event
    this.emit("ct-change", { checked: this.checked });
  }

  private _handleKeydown(event: KeyboardEvent) {
    if (this.disabled) {
      return;
    }

    // Handle Space and Enter keys
    if (
      event.key === " " || event.key === "Spacebar" || event.key === "Enter"
    ) {
      event.preventDefault();
      this._handleClick(event);
    }
  }

  /**
   * Focus the switch programmatically
   */
  override focus(): void {
    super.focus();
  }

  /**
   * Blur the switch programmatically
   */
  override blur(): void {
    super.blur();
  }
}

globalThis.customElements.define("ct-switch", CTSwitch);
