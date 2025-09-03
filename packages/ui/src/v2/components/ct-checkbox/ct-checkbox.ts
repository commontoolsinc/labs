import { css, html } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { BaseElement } from "../../core/base-element.ts";
import { type Cell } from "@commontools/runner";
import { createBooleanCellController } from "../../core/cell-controller.ts";

/**
 * CTCheckbox - Binary selection input with support for indeterminate state
 *
 * @element ct-checkbox
 *
 * @attr {boolean|Cell<boolean>} checked - Whether the checkbox is checked (supports both plain boolean and Cell<boolean>)
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
 *
 * @example
 * <!-- Reactive Cell binding -->
 * <ct-checkbox $checked={enabledCell}>Enable feature</ct-checkbox>
 */

export class CTCheckbox extends BaseElement {
  static override styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      position: relative;
      cursor: pointer;
      line-height: 1.5;

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
        left: 2.5px;
        top: -2.5px;
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

    declare checked: Cell<boolean> | boolean;
    declare disabled: boolean;
    declare indeterminate: boolean;
    declare name: string;
    declare value: string;

    private _checkedCellController = createBooleanCellController(this, {
      timing: {
        strategy: "immediate",
        delay: 0,
      },
      onChange: (newValue: boolean, oldValue: boolean) => {
        this.emit("ct-change", {
          checked: newValue,
          indeterminate: this.indeterminate,
        });
      },
    });

    constructor() {
      super();
      this.checked = false;
      this.disabled = false;
      this.indeterminate = false;
      this.name = "";
      this.value = "on";
    }

    private getChecked(): boolean {
      return this._checkedCellController.getValue();
    }

    private setChecked(newValue: boolean): void {
      this._checkedCellController.setValue(newValue);
    }

    override connectedCallback() {
      super.connectedCallback();
      // Make the element focusable
      this.tabIndex = this.disabled ? -1 : 0;
      this.setAttribute("role", "checkbox");
      this._updateAriaAttributes();
      // Bind initial checked value
      this._checkedCellController.bind(this.checked);
      // Add event listeners to the host element to make entire component clickable
      this.addEventListener("click", this._handleClick);
      this.addEventListener("keydown", this._handleKeydown);
    }

    override disconnectedCallback() {
      super.disconnectedCallback();
      // Clean up event listeners
      this.removeEventListener("click", this._handleClick);
      this.removeEventListener("keydown", this._handleKeydown);
    }

    override willUpdate(
      changedProperties: Map<string | number | symbol, unknown>,
    ) {
      super.willUpdate(changedProperties);

      // If the checked property itself changed (e.g., switched to a different cell)
      if (changedProperties.has("checked")) {
        // Bind the new checked (Cell or plain) to the controller
        this._checkedCellController.bind(this.checked);
      }
    }

    override updated(
      changedProperties: Map<string | number | symbol, unknown>,
    ) {
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
      const isChecked = this.getChecked();
      const checkboxClasses = {
        "checkbox": true,
        "checked": isChecked && !this.indeterminate,
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
        >
          <span class="checkmark" part="checkmark"></span>
        </div>
        <slot></slot>
        <input
          type="checkbox"
          class="sr-only"
          ?checked="${isChecked}"
          ?disabled="${this.disabled}"
          name="${ifDefined(this.name || undefined)}"
          value="${this.value}"
          tabindex="-1"
          aria-hidden="true"
        />
      `;
    }

    private _updateAriaAttributes() {
      const isChecked = this.getChecked();
      this.setAttribute(
        "aria-checked",
        this.indeterminate ? "mixed" : String(isChecked),
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
      const oldChecked = this.getChecked();
      this.setChecked(!oldChecked);

      // Clear indeterminate state when clicked
      if (this.indeterminate) {
        this.indeterminate = false;
      }

      // Note: ct-change event is emitted by the cell controller's onChange callback
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
