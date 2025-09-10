import { css, html } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTPromptInput - Enhanced textarea input component with send button for prompts/chat interfaces
 * Based on ct-message-input but with multiline support and prompt-specific features
 *
 * @element ct-prompt-input
 *
 * @attr {string} placeholder - Placeholder text for the textarea
 * @attr {string} buttonText - Text for the send button (default: "Send")
 * @attr {boolean} disabled - Whether the textarea and button are disabled (prevents any action)
 * @attr {boolean} pending - Whether the component is in pending state (blocks editing, shows stop button)
 * @attr {string} value - Current textarea value
 * @attr {boolean} autoResize - Whether textarea auto-resizes to fit content (default: true)
 * @attr {number} rows - Initial number of rows for the textarea (default: 1)
 * @attr {number} maxRows - Maximum number of rows for auto-resize (default: 10)
 *
 * @fires ct-send - Fired when send button is clicked or Enter is pressed (without Shift). detail: { message: string }
 * @fires ct-stop - Fired when stop button is clicked during pending state
 * @fires ct-input - Fired when textarea value changes. detail: { value: string }
 *
 * @example
 * <ct-prompt-input
 *   placeholder="Ask me anything..."
 *   button-text="Send"
 *   @ct-send="${(e) => console.log(e.detail.message)}"
 * ></ct-prompt-input>
 */
export class CTPromptInput extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        width: 100%;

        /* CSS variables for customization */
        --ct-prompt-input-gap: var(--ct-spacing-2, 0.5rem);
        --ct-prompt-input-padding: var(--ct-spacing-3, 0.75rem);
        --ct-prompt-input-border-radius: var(--ct-radius-md, 0.375rem);
        --ct-prompt-input-border: var(--ct-border-color, #e2e8f0);
        --ct-prompt-input-background: var(--ct-background, #ffffff);
        --ct-prompt-input-min-height: 2.5rem;
        --ct-prompt-input-max-height: 12rem;
      }

      .container {
        position: relative;
        display: flex;
        align-items: flex-end;
        gap: var(--ct-prompt-input-gap);
        padding: var(--ct-prompt-input-padding);
        background: var(--ct-prompt-input-background);
        border: 1px solid var(--ct-prompt-input-border);
        border-radius: var(--ct-prompt-input-border-radius);
        transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
      }

      .container:focus-within {
        border-color: var(--ct-color-primary, #3b82f6);
        box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
      }

      .textarea-wrapper {
        flex: 1;
        position: relative;
      }

      ct-textarea {
        width: 100%;
      }

      /* Override ct-textarea styles to integrate seamlessly */
      ct-textarea::part(textarea) {
        border: none;
        background: transparent;
        padding: 0;
        min-height: var(--ct-prompt-input-min-height);
        max-height: var(--ct-prompt-input-max-height);
        resize: none;
        font-family: inherit;
        font-size: 0.875rem;
        line-height: 1.25rem;
      }

      ct-textarea::part(textarea):focus {
        outline: none;
        border: none;
        box-shadow: none;
      }

      .actions {
        display: flex;
        align-items: center;
        gap: var(--ct-spacing-1, 0.25rem);
        margin-bottom: 0.125rem; /* Slight adjustment for alignment */
      }

      ct-button {
        white-space: nowrap;
        min-width: auto;
        height: 2rem;
        padding: 0 0.75rem;
      }

      /* Pending state - blocks editing but allows stop */
      :host([pending]) ct-textarea::part(textarea) {
        opacity: 0.7;
        pointer-events: none;
      }

      /* Disabled state */
      :host([disabled]) .container {
        opacity: 0.5;
        cursor: not-allowed;
      }

      /* Size variants */
      :host([size="sm"]) {
        --ct-prompt-input-padding: var(--ct-spacing-2, 0.5rem);
        --ct-prompt-input-min-height: 2rem;
      }

      :host([size="sm"]) ct-button {
        height: 1.75rem;
        padding: 0 0.5rem;
        font-size: 0.75rem;
      }

      :host([size="lg"]) {
        --ct-prompt-input-padding: var(--ct-spacing-4, 1rem);
        --ct-prompt-input-min-height: 3rem;
      }

      :host([size="lg"]) ct-button {
        height: 2.25rem;
        padding: 0 1rem;
      }

      /* Compact variant - minimal padding */
      :host([variant="compact"]) {
        --ct-prompt-input-padding: var(--ct-spacing-2, 0.5rem);
        --ct-prompt-input-gap: var(--ct-spacing-1, 0.25rem);
      }
    `,
  ];

  static override properties = {
    placeholder: { type: String },
    buttonText: { type: String, attribute: "button-text" },
    disabled: { type: Boolean, reflect: true },
    pending: { type: Boolean, reflect: true },
    value: { type: String },
    autoResize: { type: Boolean, attribute: "auto-resize" },
    rows: { type: Number },
    maxRows: { type: Number, attribute: "max-rows" },
    size: { type: String, reflect: true },
    variant: { type: String, reflect: true },
  };

  declare placeholder: string;
  declare buttonText: string;
  declare disabled: boolean;
  declare pending: boolean;
  declare value: string;
  declare autoResize: boolean;
  declare rows: number;
  declare maxRows: number;
  declare size: string;
  declare variant: string;

  private _textareaElement?: HTMLElement;

  constructor() {
    super();
    this.placeholder = "";
    this.buttonText = "Send";
    this.disabled = false;
    this.pending = false;
    this.value = "";
    this.autoResize = true;
    this.rows = 1;
    this.maxRows = 10;
    this.size = "";
    this.variant = "";
  }

  override firstUpdated() {
    this._textareaElement = this.shadowRoot?.querySelector(
      "ct-textarea",
    ) as HTMLElement;
  }

  private _handleSend(event?: Event) {
    event?.preventDefault();

    if (this.disabled || this.pending) return;

    const textarea = this._textareaElement as any;
    if (!textarea || !textarea.value?.trim()) return;

    const message = textarea.value;

    // Clear the textarea
    textarea.value = "";
    this.value = "";

    // Emit the send event
    this.emit("ct-send", { message });
  }

  private _handleStop(event?: Event) {
    event?.preventDefault();

    if (this.disabled) return;

    // Emit the stop event
    this.emit("ct-stop");
  }

  private _handleKeyDown(event: KeyboardEvent) {
    // Don't handle shortcuts if disabled or pending
    if (this.disabled || this.pending) return;

    // Enter without Shift sends the message
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      this._handleSend();
      return;
    }

    // Shift+Enter adds new line (default textarea behavior)
    // Ctrl/Cmd+Enter also sends (alternative shortcut)
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this._handleSend();
      return;
    }
  }

  private _handleInput(event: CustomEvent) {
    this.value = event.detail.value;

    // Emit input event for external listeners
    this.emit("ct-input", { value: this.value });
  }

  override render() {
    return html`
      <div class="container">
        <div class="textarea-wrapper">
          <ct-textarea
            .placeholder="${this.placeholder}"
            .value="${this.value}"
            .rows="${this.rows}"
            ?disabled="${this.disabled}"
            ?auto-resize="${this.autoResize}"
            spellcheck="true"
            @ct-input="${this._handleInput}"
            @keydown="${this._handleKeyDown}"
            part="textarea"
          ></ct-textarea>
        </div>

        <div class="actions">
          ${this.pending
            ? html`
              <ct-button
                id="ct-prompt-input-stop-button"
                variant="secondary"
                size="${this.size === "sm"
                  ? "sm"
                  : this.size === "lg"
                  ? "lg"
                  : "md"}"
                ?disabled="${this.disabled}"
                @click="${this._handleStop}"
                part="stop-button"
              >
                Stop
              </ct-button>
            `
            : html`
              <ct-button
                id="ct-prompt-input-send-button"
                variant="primary"
                size="${this.size === "sm"
                  ? "sm"
                  : this.size === "lg"
                  ? "lg"
                  : "md"}"
                ?disabled="${this.disabled || !this.value?.trim()}"
                @click="${this._handleSend}"
                part="send-button"
              >
                ${this.buttonText}
              </ct-button>
            `}
        </div>
      </div>
    `;
  }

  /**
   * Focus the textarea programmatically
   */
  override focus(): void {
    (this._textareaElement as any)?.focus?.();
  }

  /**
   * Clear the textarea value
   */
  clear(): void {
    const textarea = this._textareaElement as any;
    if (textarea) {
      textarea.value = "";
      this.value = "";
    }
  }

  /**
   * Check if the input has content
   */
  get hasContent(): boolean {
    return !!this.value?.trim();
  }
}

globalThis.customElements.define("ct-prompt-input", CTPromptInput);
