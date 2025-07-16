import { css, html } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { BaseElement } from "../../core/base-element.ts";
import { type Cell, isCell } from "@commontools/runner";

/**
 * CTInput - Text input field with support for various types and validation
 *
 * @element ct-input
 *
 * @attr {string} type - Input type: "text" | "email" | "password" | "number" | "search" | "tel" | "url" | "date" | "time" | "datetime-local"
 * @attr {string} placeholder - Placeholder text
 * @attr {string|Cell<string>} value - Input value (supports both plain string and Cell<string>)
 * @attr {boolean} disabled - Whether the input is disabled
 * @attr {boolean} readonly - Whether the input is read-only
 * @attr {boolean} required - Whether the input is required
 * @attr {string} name - Name attribute for form submission
 * @attr {string|number} min - Minimum value (for number, date inputs)
 * @attr {string|number} max - Maximum value (for number, date inputs)
 * @attr {string|number} step - Step value (for number inputs)
 * @attr {string} pattern - Validation pattern
 * @attr {string} autocomplete - Autocomplete hint
 *
 * @fires ct-input - Fired on input with detail: { value, name }
 * @fires ct-change - Fired on change with detail: { value, name }
 * @fires ct-focus - Fired on focus
 * @fires ct-blur - Fired on blur
 *
 * @example
 * <ct-input type="email" placeholder="Enter email" required></ct-input>
 */

export type InputType =
  | "text"
  | "password"
  | "email"
  | "number"
  | "tel"
  | "url"
  | "search"
  | "date"
  | "time"
  | "datetime-local"
  | "month"
  | "week"
  | "color"
  | "file";

export class CTInput extends BaseElement {
  static override styles = css`
    :host {
      display: block;
      box-sizing: border-box;
    }

    *,
    *::before,
    *::after {
      box-sizing: inherit;
    }

    input {
      display: block;
      width: 100%;
      padding: 0.5rem 0.75rem;
      font-size: 0.875rem;
      line-height: 1.25rem;
      color: var(--foreground, hsl(0, 0%, 9%));
      background-color: var(--background, hsl(0, 0%, 100%));
      border: 1px solid var(--border, hsl(0, 0%, 89%));
      border-radius: var(--radius, 0.375rem);
      transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
      font-family: inherit;
    }

    input::placeholder {
      color: var(--muted-foreground, hsl(0, 0%, 45%));
    }

    input:hover:not(:disabled):not(:focus) {
      border-color: var(--border-hover, hsl(0, 0%, 78%));
    }

    input:focus {
      outline: none;
      border-color: var(--ring, hsl(212, 100%, 47%));
      box-shadow: 0 0 0 3px var(--ring-alpha, hsla(212, 100%, 47%, 0.1));
    }

    input:disabled {
      cursor: not-allowed;
      opacity: 0.5;
      background-color: var(--muted, hsl(0, 0%, 96%));
    }

    input[readonly] {
      background-color: var(--muted, hsl(0, 0%, 96%));
    }

    input.error {
      border-color: var(--destructive, hsl(0, 100%, 50%));
    }

    input.error:focus {
      border-color: var(--destructive, hsl(0, 100%, 50%));
      box-shadow: 0 0 0 3px var(--destructive-alpha, hsla(0, 100%, 50%, 0.1));
    }

    /* Remove spinner buttons from number inputs in Chrome/Safari/Edge */
    input[type="number"]::-webkit-outer-spin-button,
    input[type="number"]::-webkit-inner-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }

    /* Remove spinner from number inputs in Firefox */
    input[type="number"] {
      -moz-appearance: textfield;
    }

    /* Style file input */
    input[type="file"] {
      padding: 0.375rem 0.75rem;
      cursor: pointer;
    }

    input[type="file"]::file-selector-button {
      margin-right: 0.5rem;
      padding: 0.125rem 0.5rem;
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--primary-foreground, hsl(0, 0%, 100%));
      background-color: var(--primary, hsl(212, 100%, 47%));
      border: none;
      border-radius: var(--radius-sm, 0.25rem);
      cursor: pointer;
    }

    input[type="file"]::file-selector-button:hover {
      background-color: var(--primary-hover, hsl(212, 100%, 42%));
    }

    /* Date/time inputs */
    input[type="date"],
    input[type="time"],
    input[type="datetime-local"],
    input[type="month"],
    input[type="week"] {
      cursor: pointer;
    }

    /* Color input */
    input[type="color"] {
      padding: 0.25rem;
      cursor: pointer;
    }

    /* Search input */
    input[type="search"]::-webkit-search-decoration,
    input[type="search"]::-webkit-search-cancel-button {
      -webkit-appearance: none;
    }
  `;

  static override properties = {
    type: { type: String },
    placeholder: { type: String },
    value: { type: String },
    disabled: { type: Boolean },
    readonly: { type: Boolean },
    error: { type: Boolean },
    name: { type: String },
    required: { type: Boolean },
    autofocus: { type: Boolean },
    autocomplete: { type: String },
    min: { type: String },
    max: { type: String },
    step: { type: String },
    pattern: { type: String },
    maxlength: { type: String },
    minlength: { type: String },
  };

  declare type: InputType;
  declare placeholder: string;
  declare value: Cell<string> | string;
  declare disabled: boolean;
  declare readonly: boolean;
  declare error: boolean;
  declare name: string;
  declare required: boolean;
  declare autofocus: boolean;
  declare autocomplete: string;
  declare min: string;
  declare max: string;
  declare step: string;
  declare pattern: string;
  declare maxlength: string;
  declare minlength: string;

  private _input: HTMLInputElement | null = null;

  constructor() {
    super();
    this.type = "text";
    this.placeholder = "";
    this.disabled = false;
    this.readonly = false;
    this.error = false;
    this.name = "";
    this.required = false;
    this.autofocus = false;
    this.autocomplete = "";
    this.min = "";
    this.max = "";
    this.step = "";
    this.pattern = "";
    this.maxlength = "";
    this.minlength = "";
  }

  private get input(): HTMLInputElement | null {
    if (!this._input) {
      this._input = this.shadowRoot?.querySelector("input") || null;
    }
    return this._input;
  }

  private getValue(): string {
    if (isCell(this.value)) {
      return this.value.get?.() || "";
    }
    return this.value || "";
  }

  private setValue(newValue: string): void {
    if (isCell(this.value)) {
      this.value.set(newValue);
    } else {
      this.value = newValue;
    }
  }

  override firstUpdated() {
    // Cache the input element reference
    this._input = this.shadowRoot?.querySelector("input") || null;

    if (this.autofocus) {
      this._input?.focus();
    }
  }

  override render() {
    return html`
      <input
        type="${this.type}"
        class="${this.error ? "error" : ""}"
        placeholder="${ifDefined(this.placeholder || undefined)}"
        .value="${this.getValue()}"
        ?disabled="${this.disabled}"
        ?readonly="${this.readonly}"
        ?required="${this.required}"
        name="${ifDefined(this.name || undefined)}"
        autocomplete="${ifDefined(this.autocomplete || undefined)}"
        min="${ifDefined(this.min || undefined)}"
        max="${ifDefined(this.max || undefined)}"
        step="${ifDefined(this.step || undefined)}"
        pattern="${ifDefined(this.pattern || undefined)}"
        maxlength="${ifDefined(this.maxlength || undefined)}"
        minlength="${ifDefined(this.minlength || undefined)}"
        @input="${this._handleInput}"
        @change="${this._handleChange}"
        @focus="${this._handleFocus}"
        @blur="${this._handleBlur}"
        @keydown="${this._handleKeyDown}"
        part="input"
      />
    `;
  }

  private _handleInput(event: Event) {
    const input = event.target as HTMLInputElement;
    const oldValue = this.getValue();
    this.setValue(input.value);

    // Emit custom input event
    this.emit("ct-input", {
      value: input.value,
      oldValue,
      name: this.name,
    });
  }

  private _handleChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const oldValue = this.getValue();
    this.setValue(input.value);

    // Emit custom change event
    this.emit("ct-change", {
      value: input.value,
      oldValue,
      name: this.name,
    });
  }

  private _handleFocus(_event: Event) {
    this.emit("ct-focus", {
      value: this.getValue(),
      name: this.name,
    });
  }

  private _handleBlur(_event: Event) {
    this.emit("ct-blur", {
      value: this.getValue(),
      name: this.name,
    });
  }

  private _handleKeyDown(event: KeyboardEvent) {
    this.emit("ct-keydown", {
      key: event.key,
      value: this.getValue(),
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      name: this.name,
    });

    // Special handling for Enter key
    if (event.key === "Enter") {
      this.emit("ct-submit", {
        value: this.getValue(),
        name: this.name,
      });
    }
  }

  /**
   * Focus the input programmatically
   */
  override focus(): void {
    this.input?.focus();
  }

  /**
   * Blur the input programmatically
   */
  override blur(): void {
    this.input?.blur();
  }

  /**
   * Select all text in the input
   */
  select(): void {
    this.input?.select();
  }

  /**
   * Set selection range in the input
   */
  setSelectionRange(
    start: number,
    end: number,
    direction?: "forward" | "backward" | "none",
  ): void {
    this.input?.setSelectionRange(start, end, direction);
  }

  /**
   * Check validity of the input
   */
  checkValidity(): boolean {
    return this.input?.checkValidity() ?? true;
  }

  /**
   * Report validity of the input
   */
  reportValidity(): boolean {
    return this.input?.reportValidity() ?? true;
  }

  /**
   * Get the validity state
   */
  get validity(): ValidityState | undefined {
    return this.input?.validity;
  }

  /**
   * Get validation message
   */
  get validationMessage(): string {
    return this.input?.validationMessage || "";
  }

  /**
   * Set custom validity message
   */
  setCustomValidity(message: string): void {
    this.input?.setCustomValidity(message);
  }
}

globalThis.customElements.define("ct-input", CTInput);
