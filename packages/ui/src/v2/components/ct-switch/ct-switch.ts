import { css, html } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { BaseElement } from "../../core/base-element.ts";
import { type CellHandle } from "@commontools/runtime-client";
import { booleanSchema } from "@commontools/runner/schemas";
import { createBooleanCellController } from "../../core/cell-controller.ts";

/**
 * CTSwitch - Toggle switch component for binary on/off states
 *
 * @element ct-switch
 *
 * @attr {boolean|CellHandle<boolean>} checked - Whether the switch is checked/on (supports both plain boolean and CellHandle<boolean>)
 * @attr {boolean} disabled - Whether the switch is disabled
 * @attr {string} name - Name attribute for form submission
 * @attr {string} value - Value attribute for form submission (default: "on")
 *
 * @fires ct-change - Fired when switch state changes with detail: { checked }
 *
 * @example
 * <ct-switch checked>Enable notifications</ct-switch>
 *
 * @example
 * <!-- Reactive Cell binding -->
 * <ct-switch $checked={enabledCell}>Enable feature</ct-switch>
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

    declare checked: CellHandle<boolean> | boolean;
    declare disabled: boolean;
    declare name: string;
    declare value: string;

    private _checkedCellController = createBooleanCellController(this, {
      timing: {
        strategy: "immediate",
        delay: 0,
      },
      onChange: (newValue: boolean, _oldValue: boolean) => {
        this.emit("ct-change", { checked: newValue });
      },
    });

    constructor() {
      super();
      this.checked = false;
      this.disabled = false;
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
      this.setAttribute("role", "switch");
      this._updateAriaAttributes();
      // Bind initial checked value
      this._checkedCellController.bind(this.checked, booleanSchema);
      // Add event listeners to the host element
      this.addEventListener("click", this._handleClick);
      this.addEventListener("keydown", this._handleKeydown);
    }

    override disconnectedCallback() {
      super.disconnectedCallback();
      this.removeEventListener("click", this._handleClick);
      this.removeEventListener("keydown", this._handleKeydown);
    }

    override willUpdate(
      changedProperties: Map<string | number | symbol, unknown>,
    ) {
      super.willUpdate(changedProperties);

      if (changedProperties.has("checked")) {
        this._checkedCellController.bind(this.checked, booleanSchema);
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
        changedProperties.has("checked") || changedProperties.has("disabled")
      ) {
        this._updateAriaAttributes();
      }
    }

    override render() {
      const isChecked = this.getChecked();
      const switchClasses = {
        "switch": true,
        "checked": isChecked,
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
        >
          <span class="thumb" part="thumb"></span>
        </div>
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
      this.setAttribute("aria-checked", String(isChecked));
      this.setAttribute("aria-disabled", String(this.disabled));
    }

    private _handleClick(event: Event) {
      if (this.disabled) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const oldChecked = this.getChecked();

      // Toggle checked state via cell controller
      if (this._checkedCellController.hasCell()) {
        this.setChecked(!oldChecked);
        return;
      }

      // For plain boolean usage (no Cell), update the property directly
      this.checked = !oldChecked;
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
