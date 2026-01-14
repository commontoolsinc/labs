import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { BaseElement } from "../../core/base-element.ts";
import { consume } from "@lit/context";
import {
  applyThemeToElement,
  type CTTheme,
  defaultTheme,
  themeContext,
} from "../theme-context.ts";
import { type CellHandle } from "@commontools/runtime-client";
import { stringSchema } from "@commontools/runner/schemas";
import { createStringCellController } from "../../core/cell-controller.ts";

export type TimingStrategy = "immediate" | "debounce" | "throttle" | "blur";

/**
 * CTTextarea - Multi-line text input with support for auto-resize, various states, and reactive data binding
 *
 * @element ct-textarea
 *
 * @attr {string} placeholder - Placeholder text
 * @attr {string|CellHandle<string>} value - Textarea value (supports both plain string and CellHandle<string>)
 * @attr {boolean} disabled - Whether the textarea is disabled
 * @attr {boolean} readonly - Whether the textarea is read-only
 * @attr {boolean} required - Whether the textarea is required
 * @attr {string} name - Name attribute for form submission
 * @attr {number} rows - Number of visible text rows
 * @attr {number} cols - Number of visible text columns
 * @attr {number} maxlength - Maximum number of characters allowed
 * @attr {boolean} auto-resize - Whether the textarea automatically resizes to fit content
 * @attr {string} timingStrategy - Input timing strategy: "immediate" | "debounce" | "throttle" | "blur"
 * @attr {number} timingDelay - Delay in milliseconds for debounce/throttle (default: 300)
 *
 * @fires ct-input - Fired on input with detail: { value, oldValue, name }
 * @fires ct-change - Fired on change with detail: { value, oldValue, name }
 * @fires ct-focus - Fired on focus with detail: { value, name }
 * @fires ct-blur - Fired on blur with detail: { value, name }
 * @fires ct-keydown - Fired on keydown with detail: { key, value, shiftKey, ctrlKey, metaKey, altKey, name }
 * @fires ct-submit - Fired on Ctrl/Cmd+Enter with detail: { value, name }
 *
 * @example
 * <ct-textarea rows="4" placeholder="Enter message" auto-resize></ct-textarea>
 *
 * @example
 * <!-- With Cell binding for two-way reactive updates -->
 * <ct-textarea .value="${myCell}" placeholder="Type here..."></ct-textarea>
 *
 * @example
 * <!-- Debounced input - waits 500ms after user stops typing -->
 * <ct-textarea timingStrategy="debounce" timingDelay="500" placeholder="Search..."></ct-textarea>
 */

export class CTTextarea extends BaseElement {
  static override properties = {
    placeholder: { type: String },
    value: { type: String },
    disabled: { type: Boolean },
    readonly: { type: Boolean },
    error: { type: Boolean },
    rows: { type: Number },
    cols: { type: Number },
    name: { type: String },
    required: { type: Boolean },
    autofocus: { type: Boolean },
    maxlength: { type: String },
    minlength: { type: String },
    wrap: { type: String },
    spellcheck: { type: Boolean },
    autocomplete: { type: String },
    resize: { type: String },
    autoResize: { type: Boolean, attribute: "auto-resize" },
    timingStrategy: { type: String, attribute: "timing-strategy" },
    timingDelay: { type: Number, attribute: "timing-delay" },
  };
  declare placeholder: string;
  declare value: CellHandle<string> | string;
  declare disabled: boolean;
  declare readonly: boolean;
  declare error: boolean;
  declare rows: number;
  declare cols: number;
  declare name: string;
  declare required: boolean;
  declare autofocus: boolean;
  declare maxlength: string;
  declare minlength: string;
  declare wrap: string;
  declare spellcheck: boolean;
  declare autocomplete: string;
  declare resize: string;
  declare autoResize: boolean;
  declare timingStrategy: TimingStrategy;
  declare timingDelay: number;

  static override styles = css`
    :host {
      display: block;
      width: 100%;

      /* Default color values if not provided */
      --background: var(--ct-theme-color-background, #ffffff);
      --foreground: var(--ct-theme-color-text, #0f172a);
      --border: var(--ct-theme-color-border, #e2e8f0);
      --ring: var(--ct-theme-color-primary, #3b82f6);
      --destructive: var(--ct-theme-color-error, #dc2626);
      --muted: var(--ct-theme-color-surface, #f1f5f9);
      --muted-foreground: var(--ct-theme-color-text-muted, #64748b);
      --placeholder: var(--ct-theme-color-text-muted, #94a3b8);

      /* Textarea dimensions */
      --textarea-padding-x: 0.75rem;
      --textarea-padding-y: 0.5rem;
      --textarea-font-size: 0.875rem;
      --textarea-line-height: 1.25rem;
      --textarea-border-radius: var(--ct-theme-border-radius, 0.375rem);
      --textarea-min-height: 5rem;
    }

    textarea {
      all: unset;
      box-sizing: border-box;
      width: 100%;
      min-height: var(--textarea-min-height);
      padding: var(--textarea-padding-y) var(--textarea-padding-x);
      font-size: var(--textarea-font-size);
      line-height: var(--textarea-line-height);
      font-family: var(--ct-theme-font-family, inherit);
      color: var(--foreground);
      background-color: var(--background);
      border: 1px solid var(--border);
      border-radius: var(--textarea-border-radius);
      transition: all var(--ct-theme-animation-duration, 150ms)
        var(--ct-transition-timing-ease);
      display: block;
      overflow: auto;
      word-wrap: break-word;
      white-space: pre-wrap;
    }

    /* Default resize behavior */
    textarea {
      resize: vertical;
    }

    /* Override resize when specified */
    textarea[style*="resize: none"] {
      resize: none !important;
    }

    textarea[style*="resize: horizontal"] {
      resize: horizontal !important;
    }

    textarea[style*="resize: both"] {
      resize: both !important;
    }

    textarea::placeholder {
      color: var(--placeholder);
      opacity: 1;
    }

    textarea::-webkit-input-placeholder {
      color: var(--placeholder);
      opacity: 1;
    }

    textarea::-moz-placeholder {
      color: var(--placeholder);
      opacity: 1;
    }

    textarea:-ms-input-placeholder {
      color: var(--placeholder);
      opacity: 1;
    }

    /* Focus state */
    textarea:focus {
      outline: 2px solid transparent;
      outline-offset: 2px;
      border-color: var(--ring);
      box-shadow: 0 0 0 3px
        var(--ct-theme-color-primary, rgba(59, 130, 246, 0.15));
      }

      textarea:focus-visible {
        outline: 2px solid transparent;
        outline-offset: 2px;
        border-color: var(--ring);
        box-shadow: 0 0 0 3px
          var(--ct-theme-color-primary, rgba(59, 130, 246, 0.15));
        }

        /* Disabled state */
        textarea:disabled {
          cursor: not-allowed;
          opacity: 0.5;
          background-color: var(--muted);
          resize: none;
        }

        /* Readonly state */
        textarea:read-only {
          background-color: var(--muted);
          cursor: default;
        }

        /* Error state */
        textarea.error {
          border-color: var(--destructive);
        }

        textarea.error:focus,
        textarea.error:focus-visible {
          border-color: var(--destructive);
          box-shadow: 0 0 0 3px var(--ct-theme-color-error, rgba(220, 38, 38, 0.1));
        }

        /* Scrollbar styling */
        textarea::-webkit-scrollbar {
          width: 0.5rem;
          height: 0.5rem;
        }

        textarea::-webkit-scrollbar-track {
          background-color: var(--muted);
          border-radius: calc(var(--textarea-border-radius) * 0.5);
        }

        textarea::-webkit-scrollbar-thumb {
          background-color: var(--border);
          border-radius: calc(var(--textarea-border-radius) * 0.5);
          transition: background-color var(--ct-theme-animation-duration, 150ms);
        }

        textarea::-webkit-scrollbar-thumb:hover {
          background-color: var(--muted-foreground);
        }

        /* Firefox scrollbar styling */
        textarea {
          scrollbar-width: thin;
          scrollbar-color: var(--border) var(--muted);
        }

        /* Autofill styles */
        textarea:-webkit-autofill,
        textarea:-webkit-autofill:hover,
        textarea:-webkit-autofill:focus {
          -webkit-text-fill-color: var(--foreground);
          -webkit-box-shadow: 0 0 0px 1000px var(--muted) inset;
          transition: background-color 5000s ease-in-out 0s;
        }

        /* Selection styles */
        textarea::selection {
          background-color: var(--ring);
          color: var(--background);
          opacity: 0.3;
        }

        textarea::-moz-selection {
          background-color: var(--ring);
          color: var(--background);
          opacity: 0.3;
        }

        /* Auto-resize specific styles */
        :host([auto-resize]) textarea {
          overflow-y: hidden;
        }
      `;

      // Theme consumption
      @consume({ context: themeContext, subscribe: true })
      @property({ attribute: false })
      declare theme?: CTTheme;

      // Cache + initial setup
      private _textarea: HTMLTextAreaElement | null = null;
      private _cellController = createStringCellController(this, {
        timing: {
          strategy: "debounce",
          delay: 300,
        },
      });

      constructor() {
        super();
        this.placeholder = "";
        this.value = "";
        this.disabled = false;
        this.readonly = false;
        this.error = false;
        this.rows = 4;
        this.cols = 50;
        this.name = "";
        this.required = false;
        this.autofocus = false;
        this.maxlength = "";
        this.minlength = "";
        this.wrap = "soft";
        this.spellcheck = true;
        this.autocomplete = "off";
        this.resize = "vertical";
        this.autoResize = false;
        this.timingStrategy = "debounce";
        this.timingDelay = 300;
      }

      private getValue(): string {
        return this._cellController.getValue();
      }

      private setValue(newValue: string): void {
        this._cellController.setValue(newValue);
      }

      get textarea(): HTMLTextAreaElement | null {
        if (!this._textarea) {
          this._textarea = this.shadowRoot?.querySelector("textarea") as
            | HTMLTextAreaElement
            | null;
        }
        return this._textarea;
      }

      private _minHeight = 0;

      override firstUpdated() {
        // Cache reference
        this._textarea = this.shadowRoot?.querySelector("textarea") as
          | HTMLTextAreaElement
          | null;

        // Bind the initial value to the cell controller
        this._cellController.bind(this.value, stringSchema);

        // Update timing options to match current properties
        this._cellController.updateTimingOptions({
          strategy: this.timingStrategy,
          delay: this.timingDelay,
        });

        // Apply theme on mount
        applyThemeToElement(this, this.theme ?? defaultTheme);

        if (this.autofocus) {
          this.textarea?.focus();
        }

        // Store initial height for auto-resize
        if (this.autoResize && this.textarea) {
          this._minHeight = this.textarea.scrollHeight;
          this.adjustHeight();
        }
      }

      override updated(
        changedProperties: Map<string | number | symbol, unknown>,
      ) {
        super.updated(changedProperties);

        if (changedProperties.has("value")) {
          // Bind the new value (Cell or plain) to the controller
          this._cellController.bind(this.value, stringSchema);
        }

        // Update timing options if they changed
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

        if (changedProperties.has("value") && this.autoResize) {
          this.adjustHeight();
        }

        if (changedProperties.has("autoResize")) {
          if (this.autoResize) {
            this.resize = "none";
            if (this.textarea) {
              this._minHeight = this.textarea.scrollHeight;
              this.adjustHeight();
            }
          } else {
            this.resize = "vertical";
          }
        }
      }

      override render() {
        const resizeStyle = this.resize === "none" || this.autoResize
          ? "resize: none;"
          : `resize: ${this.resize};`;

        return html`
          <textarea
            class="${this.error ? "error" : ""}"
            style="${resizeStyle}"
            placeholder="${ifDefined(this.placeholder || undefined)}"
            .value="${this.getValue()}"
            ?disabled="${this.disabled}"
            ?readonly="${this.readonly}"
            ?required="${this.required}"
            name="${ifDefined(this.name || undefined)}"
            rows="${this.rows}"
            cols="${this.cols}"
            wrap="${this.wrap}"
            ?spellcheck="${this.spellcheck}"
            autocomplete="${this.autocomplete}"
            maxlength="${ifDefined(this.maxlength || undefined)}"
            minlength="${ifDefined(this.minlength || undefined)}"
            @input="${this._handleInput}"
            @change="${this._handleChange}"
            @focus="${this._handleFocus}"
            @blur="${this._handleBlur}"
            @keydown="${this._handleKeyDown}"
            part="textarea"
          ></textarea>
        `;
      }

      private _handleInput(event: Event) {
        const textarea = event.target as HTMLTextAreaElement;
        const oldValue = this.getValue();
        this.setValue(textarea.value);

        // Auto-resize if enabled
        if (this.autoResize) {
          this.adjustHeight();
        }

        // Emit custom input event
        this.emit("ct-input", {
          value: textarea.value,
          oldValue,
          name: this.name,
        });
      }

      private _handleChange(event: Event) {
        const textarea = event.target as HTMLTextAreaElement;
        const oldValue = this.getValue();

        // Emit custom change event
        this.emit("ct-change", {
          value: textarea.value,
          oldValue,
          name: this.name,
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

        // Special handling for Enter key with modifiers
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          this.emit("ct-submit", {
            value: this.getValue(),
            name: this.name,
          });
        }
      }

      /**
       * Adjust height for auto-resize functionality
       */
      private adjustHeight(): void {
        if (!this.textarea || !this.autoResize) return;

        // Reset height to recalculate
        (this.textarea as HTMLTextAreaElement).style.height = "auto";

        // Set new height based on scrollHeight
        const newHeight = Math.max(
          this._minHeight,
          (this.textarea as HTMLTextAreaElement).scrollHeight,
        );
        (this.textarea as HTMLTextAreaElement).style.height = `${newHeight}px`;
      }

      /**
       * Focus the textarea programmatically
       */
      override focus(): void {
        this.textarea?.focus();
      }

      /**
       * Blur the textarea programmatically
       */
      override blur(): void {
        this.textarea?.blur();
      }

      /**
       * Select all text in the textarea
       */
      select(): void {
        this.textarea?.select();
      }

      /**
       * Set selection range in the textarea
       */
      setSelectionRange(
        start: number,
        end: number,
        direction?: "forward" | "backward" | "none",
      ): void {
        this.textarea?.setSelectionRange(start, end, direction);
      }

      /**
       * Check validity of the textarea
       */
      checkValidity(): boolean {
        return this.textarea?.checkValidity() ?? true;
      }

      /**
       * Report validity of the textarea
       */
      reportValidity(): boolean {
        return this.textarea?.reportValidity() ?? true;
      }

      /**
       * Get the validity state
       */
      get validity(): ValidityState | undefined {
        return this.textarea?.validity;
      }

      /**
       * Get validation message
       */
      get validationMessage(): string {
        return this.textarea?.validationMessage || "";
      }

      /**
       * Set custom validity message
       */
      setCustomValidity(message: string): void {
        this.textarea?.setCustomValidity(message);
      }
    }

    globalThis.customElements.define("ct-textarea", CTTextarea);
