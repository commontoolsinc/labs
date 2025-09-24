import { css, html } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { BaseElement } from "../../core/base-element.ts";
import { consume } from "@lit/context";
import {
  applyThemeToElement,
  defaultTheme,
  type CTTheme,
  themeContext,
} from "../theme-context.ts";
import { type Cell } from "@commontools/runner";
import { type InputTimingOptions } from "../../core/input-timing-controller.ts";
import { createStringCellController } from "../../core/cell-controller.ts";

/**
 * CTInput - Enhanced input field with support for various types, validation patterns, and reactive data binding
 *
 * @element ct-input
 *
 * @attr {string} type - Input type: "text" | "email" | "password" | "number" | "search" | "tel" | "url" | "date" | "time" | "datetime-local" | "month" | "week" | "color" | "file" | "range" | "hidden"
 * @attr {string} placeholder - Placeholder text
 * @attr {string|Cell<string>} value - Input value (supports both plain string and Cell<string>)
 * @attr {boolean} disabled - Whether the input is disabled
 * @attr {boolean} readonly - Whether the input is read-only
 * @attr {boolean} required - Whether the input is required
 * @attr {string} name - Name attribute for form submission
 * @attr {string|number} min - Minimum value (for number, date, range inputs)
 * @attr {string|number} max - Maximum value (for number, date, range inputs)
 * @attr {string|number} step - Step value (for number, range inputs)
 * @attr {string} pattern - Custom validation pattern (regex)
 * @attr {string} validationPattern - Predefined pattern: "email" | "url" | "tel-us" | "tel-intl" | "credit-card" | "zip-us" | "alphanumeric" | "letters" | "numbers"
 * @attr {string} autocomplete - Autocomplete hint
 * @attr {string} inputmode - Virtual keyboard mode: "none" | "text" | "decimal" | "numeric" | "tel" | "search" | "email" | "url"
 * @attr {number} size - Width of input in characters
 * @attr {boolean} multiple - Allow multiple files (file input only)
 * @attr {string} accept - File types to accept (file input only)
 * @attr {string} list - ID of datalist element for suggestions
 * @attr {string} spellcheck - Enable/disable spellcheck
 * @attr {boolean} showValidation - Show validation state visually
 * @attr {boolean} error - Manual error state override
 * @attr {string} timingStrategy - Input timing strategy: "immediate" | "debounce" | "throttle" | "blur"
 * @attr {number} timingDelay - Delay in milliseconds for debounce/throttle (default: 300)
 *
 * @fires ct-change - Fired when value changes (timing depends on strategy) with detail: { value, oldValue, name, files? }
 * @fires ct-focus - Fired on focus with detail: { value, name }
 * @fires ct-blur - Fired on blur with detail: { value, name }
 * @fires ct-keydown - Fired on keydown with detail: { key, value, shiftKey, ctrlKey, metaKey, altKey, name }
 * @fires ct-submit - Fired on Enter key with detail: { value, name }
 * @fires ct-invalid - Fired on validation failure with detail: { value, name, validationMessage, validity }
 *
 * @example
 * <ct-input type="email" placeholder="Enter email" required showValidation></ct-input>
 *
 * @example
 * <ct-input type="tel" validationPattern="tel-us" placeholder="(123) 456-7890"></ct-input>
 *
 * @example
 * <ct-input type="number" min="0" max="100" step="5"></ct-input>
 *
 * @example
 * <!-- Debounced input - waits 500ms after user stops typing -->
 * <ct-input timingStrategy="debounce" timingDelay="500" placeholder="Search..."></ct-input>
 *
 * @example
 * <!-- Only emit events when input loses focus -->
 * <ct-input timingStrategy="blur" placeholder="Enter value"></ct-input>
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
  | "file"
  | "range"
  | "hidden";

export type InputMode =
  | "none"
  | "text"
  | "decimal"
  | "numeric"
  | "tel"
  | "search"
  | "email"
  | "url";

// Common validation patterns for different input types
export const INPUT_PATTERNS = {
  // Email pattern (basic validation)
  email: "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}",
  // URL pattern (http/https)
  url: "https?://.+",
  // US Phone pattern (various formats)
  "tel-us": "\\+?1?[-.]?\\(?([0-9]{3})\\)?[-.]?([0-9]{3})[-.]?([0-9]{4})",
  // International phone
  "tel-intl":
    "\\+?[0-9]{1,4}?[-.]?\\(?([0-9]{1,4})\\)?[-.]?([0-9]{1,4})[-.]?([0-9]{1,9})",
  // Credit card (basic - digits with optional spaces/dashes)
  "credit-card": "[0-9]{4}[-\\s]?[0-9]{4}[-\\s]?[0-9]{4}[-\\s]?[0-9]{4}",
  // ZIP code (US 5 or 9 digit)
  "zip-us": "[0-9]{5}(-[0-9]{4})?",
  // Alphanumeric only
  alphanumeric: "[a-zA-Z0-9]+",
  // Letters only
  letters: "[a-zA-Z]+",
  // Numbers only
  numbers: "[0-9]+",
} as const;

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
      color: var(--ct-theme-color-text, #111827);
      background-color: var(--ct-theme-color-background, #ffffff);
      border: 1px solid var(--ct-theme-color-border, #e5e7eb);
      border-radius: var(
        --ct-theme-border-radius,
        var(--ct-border-radius-md, 0.375rem)
      );
      transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
      font-family: var(--ct-theme-font-family, inherit);
    }

    input::placeholder {
      color: var(--ct-theme-color-text-muted, #6b7280);
    }

    input:hover:not(:disabled):not(:focus) {
      border-color: var(--ct-theme-color-border, #d1d5db);
    }

    input:focus {
      outline: none;
      border-color: var(--ct-theme-color-primary, #3b82f6);
      box-shadow: 0 0 0 3px
        var(--ct-theme-color-primary, rgba(59, 130, 246, 0.15));
    }

    input:disabled {
      cursor: not-allowed;
      opacity: 0.5;
      background-color: var(--ct-theme-color-surface, #f1f5f9);
    }

    input[readonly] {
      background-color: var(--ct-theme-color-surface, #f1f5f9);
    }

    input.error {
      border-color: var(--ct-theme-color-error, #dc2626);
    }

    input.error:focus {
      border-color: var(--ct-theme-color-error, #dc2626);
      box-shadow: 0 0 0 3px
        var(--ct-theme-color-error, rgba(220, 38, 38, 0.15));
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

    /* Range input */
    input[type="range"] {
      padding: 0.5rem 0;
      cursor: pointer;
    }

    input[type="range"]::-webkit-slider-track {
      width: 100%;
      height: 4px;
      background: var(--ct-theme-color-surface, #f1f5f9);
      border-radius: 2px;
    }

    input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 16px;
      height: 16px;
      background: var(--ct-theme-color-primary, #3b82f6);
      border-radius: 50%;
      cursor: pointer;
    }

    input[type="range"]::-moz-range-track {
      width: 100%;
      height: 4px;
      background: var(--ct-theme-color-surface, #f1f5f9);
      border-radius: 2px;
    }

    input[type="range"]::-moz-range-thumb {
      width: 16px;
      height: 16px;
      background: var(--ct-theme-color-primary, #3b82f6);
      border-radius: 50%;
      border: none;
      cursor: pointer;
    }

    /* Hidden input */
    input[type="hidden"] {
      display: none;
    }

    /* Valid state (when showValidation is true) */
    input:valid:not(:placeholder-shown) {
      border-color: var(--ct-theme-color-success, #16a34a);
    }

    input:valid:not(:placeholder-shown):focus {
      border-color: var(--ct-theme-color-success, #16a34a);
      box-shadow: 0 0 0 3px
        var(--ct-theme-color-success, rgba(22, 163, 74, 0.15));
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
    inputmode: { type: String },
    size: { type: Number },
    multiple: { type: Boolean },
    accept: { type: String },
    list: { type: String },
    spellcheck: { type: Boolean },
    validationPattern: { type: String },
    showValidation: { type: Boolean },
    timingStrategy: { type: String },
    timingDelay: { type: Number },
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
  declare inputmode: InputMode;
  declare size: number;
  declare multiple: boolean;
  declare accept: string;
  declare list: string;
  declare spellcheck: boolean;
  declare validationPattern: keyof typeof INPUT_PATTERNS | "";
  declare showValidation: boolean;
  declare timingStrategy: InputTimingOptions["strategy"];
  declare timingDelay: number;

  private _input: HTMLInputElement | null = null;
  private _cellController = createStringCellController(this, {
    timing: {
      strategy: "debounce",
      delay: 300,
    },
    onChange: (newValue: string, oldValue: string) => {
      this.emit("ct-change", {
        value: newValue,
        oldValue,
        name: this.name,
        files: this.type === "file" ? this._input?.files : undefined,
      });
    },
  });

  constructor() {
    super();
    this.type = "text";
    this.placeholder = "";
    this.value = "";
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
    this.inputmode = "text";
    this.size = 0;
    this.multiple = false;
    this.accept = "";
    this.list = "";
    this.spellcheck = true;
    this.validationPattern = "";
    this.showValidation = false;
    this.timingStrategy = "debounce";
    this.timingDelay = 300;
  }

  // Theme consumption
  @consume({ context: themeContext, subscribe: true })
  // deno-lint-ignore no-explicit-any
  declare theme?: CTTheme;

  private get input(): HTMLInputElement | null {
    if (!this._input) {
      this._input = this.shadowRoot?.querySelector("input") || null;
    }
    return this._input;
  }

  private getValue(): string {
    return this._cellController.getValue();
  }

  private setValue(newValue: string, _files?: FileList | null): void {
    // Store files reference for the onChange handler
    this._cellController.setValue(newValue);
  }

  private getPattern(): string {
    // Use custom pattern if provided
    if (this.pattern) {
      return this.pattern;
    }

    // Use validation pattern if specified
    if (this.validationPattern && this.validationPattern in INPUT_PATTERNS) {
      return INPUT_PATTERNS[this.validationPattern];
    }

    // Use default patterns for specific types
    if (this.type === "email" && !this.pattern) {
      return INPUT_PATTERNS.email;
    }
    if (this.type === "url" && !this.pattern) {
      return INPUT_PATTERNS.url;
    }

    return "";
  }

  private getInputMode(): InputMode {
    // Use explicit inputmode if provided
    if (this.inputmode && this.inputmode !== "text") {
      return this.inputmode;
    }

    // Return appropriate inputmode based on type
    switch (this.type) {
      case "email":
        return "email";
      case "tel":
        return "tel";
      case "url":
        return "url";
      case "number":
        return "numeric";
      case "search":
        return "search";
      default:
        return "text";
    }
  }

  private getValidationClass(): string {
    if (!this.showValidation) {
      return this.error ? "error" : "";
    }

    // Check native validation
    const isValid = this.checkValidity();
    return isValid ? "" : "error";
  }

  override connectedCallback() {
    super.connectedCallback();
    // CellController handles subscription automatically via ReactiveController
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    // CellController handles cleanup automatically via ReactiveController
  }

  override willUpdate(changedProperties: Map<string, any>) {
    super.willUpdate(changedProperties);

    // If the value property itself changed (e.g., switched to a different cell)
    if (changedProperties.has("value")) {
      // Bind the new value (Cell or plain) to the controller
      // This updates the internal reference so getValue() returns the correct value
      this._cellController.bind(this.value);
    }
  }

  override updated(changedProperties: Map<string, any>) {
    super.updated(changedProperties);

    // If value changed, ensure the DOM input is synchronized
    if (changedProperties.has("value") && this.input) {
      const currentValue = this.getValue();
      if (this.input.value !== currentValue) {
        this.input.value = currentValue;
      }
    }

    // Update timing controller if timing options changed
    if (
      changedProperties.has("timingStrategy") ||
      changedProperties.has("timingDelay")
    ) {
      this._cellController.updateTimingOptions({
        strategy: this.timingStrategy,
        delay: this.timingDelay,
      });
    }

    if (changedProperties.has("theme")) {
      applyThemeToElement(this, this.theme ?? defaultTheme);
    }
  }

  override firstUpdated() {
    // Cache the input element reference
    this._input = this.shadowRoot?.querySelector("input") || null;

    // Bind the initial value to the cell controller
    this._cellController.bind(this.value);

    // Update timing options to match current properties
    this._cellController.updateTimingOptions({
      strategy: this.timingStrategy,
      delay: this.timingDelay,
    });

    if (this.autofocus) {
      this._input?.focus();
    }

    // Apply theme after first render
    applyThemeToElement(this, this.theme ?? defaultTheme);
  }

  override render() {
    const pattern = this.getPattern();
    const inputMode = this.getInputMode();
    const validationClass = this.getValidationClass();

    // For file inputs, we can't set the value programmatically
    const inputValue = this.type === "file" ? undefined : this.getValue();

    return html`
      <input
        type="${this.type}"
        data-ct-input
        class="${validationClass}"
        placeholder="${ifDefined(this.placeholder || undefined)}"
        .value="${ifDefined(inputValue)}"
        ?disabled="${this.disabled}"
        ?readonly="${this.readonly}"
        ?required="${this.required}"
        name="${ifDefined(this.name || undefined)}"
        autocomplete="${ifDefined(this.autocomplete || undefined)}"
        min="${ifDefined(this.min || undefined)}"
        max="${ifDefined(this.max || undefined)}"
        step="${ifDefined(this.step || undefined)}"
        pattern="${ifDefined(pattern || undefined)}"
        maxlength="${ifDefined(this.maxlength || undefined)}"
        minlength="${ifDefined(this.minlength || undefined)}"
        inputmode="${ifDefined(inputMode || undefined)}"
        size="${ifDefined(this.size || undefined)}"
        ?multiple="${this.multiple && this.type === "file"}"
        accept="${ifDefined(
          this.accept && this.type === "file" ? this.accept : undefined,
        )}"
        list="${ifDefined(this.list || undefined)}"
        ?spellcheck="${this.spellcheck}"
        @input="${this._handleInput}"
        @change="${this._handleChange}"
        @focus="${this._handleFocus}"
        @blur="${this._handleBlur}"
        @keydown="${this._handleKeyDown}"
        @invalid="${this._handleInvalid}"
        part="input"
      />
    `;
  }

  private _handleInput(event: Event) {
    const input = event.target as HTMLInputElement;
    const oldValue = this.getValue();

    // For file inputs, we can't set the value programmatically
    if (this.type !== "file") {
      this.setValue(input.value, input.files);
    } else {
      // For file inputs, still emit the event with files
      this.setValue("", input.files);
    }

    // Emit ct-input event directly for non-cell interop
    this.emit("ct-input", {
      value: this.type === "file" ? "" : input.value,
      oldValue,
      name: this.name,
      files: this.type === "file" ? input.files : undefined,
    });
  }

  private _handleChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const oldValue = this.getValue();

    // Change events use the same setValue logic as input events
    // The timing controller will determine when to actually emit
    if (this.type !== "file") {
      this.setValue(input.value, input.files);
    } else {
      this.setValue("", input.files);
    }

    // Emit ct-change event directly for non-cell interop
    // This ensures the event is emitted regardless of timing strategy
    this.emit("ct-change", {
      value: this.type === "file" ? "" : input.value,
      oldValue,
      name: this.name,
      files: this.type === "file" ? input.files : undefined,
    });
  }

  private _handleFocus(_event: Event) {
    this._cellController.onFocus();
    this.emit("ct-focus", {
      value: this.getValue(),
      name: this.name,
    });
  }

  private _handleBlur(_event: Event) {
    this._cellController.onBlur();
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

  private _handleInvalid(event: Event) {
    event.preventDefault(); // Prevent browser's default validation UI

    const input = event.target as HTMLInputElement;
    this.emit("ct-invalid", {
      value: this.getValue(),
      name: this.name,
      validationMessage: input.validationMessage,
      validity: input.validity,
    });

    // Update visual state if showValidation is enabled
    if (this.showValidation) {
      this.requestUpdate();
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
