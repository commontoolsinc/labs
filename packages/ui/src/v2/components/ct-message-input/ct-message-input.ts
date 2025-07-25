import { css, html } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTMessageInput - Input component with send button for messages/chat interfaces
 *
 * @element ct-message-input
 *
 * @attr {string} placeholder - Placeholder text for the input
 * @attr {string} buttonText - Text for the send button (default: "Send")
 * @attr {boolean} disabled - Whether the input and button are disabled
 * @attr {string} value - Current input value
 *
 * @fires ct-send - Fired when send button is clicked or Enter is pressed. detail: { message: string }
 *
 * @example
 * <ct-message-input
 *   placeholder="Type a message..."
 *   button-text="Send"
 *   @ct-send="${(e) => console.log(e.detail.message)}"
 * ></ct-message-input>
 */
export class CTMessageInput extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        width: 100%;
      }

      .container {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: var(--ct-spacing-2, 0.5rem);
        align-items: center;
      }

      ct-input {
        width: 100%;
      }

      ct-button {
        white-space: nowrap;
      }

      /* Allow customization via CSS variables */
      .container {
        --input-height: var(--ct-message-input-height, 2.5rem);
      }

      ct-input::part(input) {
        height: var(--input-height);
      }

      ct-button {
        height: var(--input-height);
      }
    `,
  ];

  static override properties = {
    placeholder: { type: String },
    buttonText: { type: String, attribute: "button-text" },
    disabled: { type: Boolean, reflect: true },
    value: { type: String },
  };

  declare placeholder: string;
  declare buttonText: string;
  declare disabled: boolean;
  declare value: string;

  private _inputElement?: HTMLElement;

  constructor() {
    super();
    this.placeholder = "";
    this.buttonText = "Send";
    this.disabled = false;
    this.value = "";
  }

  override firstUpdated() {
    this._inputElement = this.shadowRoot?.querySelector(
      "ct-input",
    ) as HTMLElement;
  }

  private _handleSend(event?: Event) {
    event?.preventDefault();

    const input = this._inputElement as any;
    if (!input || !input.value?.trim()) return;

    const message = input.value;

    // Clear the input
    input.value = "";
    this.value = "";

    // Emit the send event
    this.emit("ct-send", { message });
  }

  private _handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      this._handleSend();
    }
  }

  private _handleInput(event: CustomEvent) {
    this.value = event.detail.value;
  }

  override render() {
    return html`
      <div class="container">
        <ct-input
          type="text"
          .placeholder="${this.placeholder}"
          .value="${this.value}"
          ?disabled="${this.disabled}"
          @ct-change="${this._handleInput}"
          part="input"
        ></ct-input>
        <ct-button
          ?disabled="${this.disabled}"
          @click="${this._handleSend}"
          part="button"
        >
          ${this.buttonText}
        </ct-button>
      </div>
    `;
  }
}

globalThis.customElements.define("ct-message-input", CTMessageInput);
