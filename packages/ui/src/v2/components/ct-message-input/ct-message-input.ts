import { css, html } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { BaseElement } from "../../core/base-element.ts";
import { type Cell } from "@commontools/runner";
import { cell, getCellValue, setCellValue } from "../../core/cell-decorator.ts";

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
  };

  declare placeholder: string;
  declare buttonText: string;
  declare disabled: boolean;

  @cell()
  value: Cell<string> | undefined;

  constructor() {
    super();
    this.placeholder = "";
    this.buttonText = "Send";
    this.disabled = false;
  }

  private _handleSend(event?: Event) {
    event?.preventDefault();

    const currentValue = getCellValue(this, "value");
    if (
      !currentValue || typeof currentValue !== "string" || !currentValue.trim()
    ) return;

    const message = currentValue;

    // Clear the input using setCellValue helper
    setCellValue(this, "value", "");

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
    // The ct-input child component will handle the Cell updates automatically
    // No need for manual value tracking since we're using the @cell() decorator
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
