import { css, html, LitElement } from "lit";
import { baseStyles } from "./style.ts";

export class SendMessageElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
      }

      :host([inline]) {
        display: inline-block;
      }

      .unibox {
        display: grid;
        grid-template-columns: 1fr min-content;
        column-gap: var(--gap);
      }
    `,
  ];

  static override properties = {
    name: { type: String },
    placeholder: { type: String },
    inline: { type: Boolean, reflect: true },
    value: { type: String },
  };

  declare name: string;
  declare placeholder: string;
  declare inline: boolean;
  declare value: string;

  constructor() {
    super();
    this.name = "";
    this.placeholder = "";
    this.inline = false;
    this.value = "";
  }

  send(event: Event) {
    event.preventDefault();

    const inputEl = this.shadowRoot?.getElementById(
      "input",
    ) as HTMLInputElement;
    if (!inputEl) return;
    const value = inputEl.value;
    inputEl.value = "";

    this.dispatchEvent(
      new CustomEvent("messagesend", {
        detail: { message: value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  keyDown(event: KeyboardEvent) {
    if (event.key === "Enter") this.send(event);
  }

  override render() {
    return html`
      <div class="unibox">
        <common-input
          appearance="rounded"
          class="unibox-input"
          id="input"
          .placeholder="${this.placeholder}"
          .value="${this.value}"
          @keydown="${this.keyDown}"
        >
        </common-input>
        <common-button class="unibox-button" @click="${this.send}"
        >${this.name}</common-button>
      </div>
    `;
  }
}
globalThis.customElements.define("common-send-message", SendMessageElement);
