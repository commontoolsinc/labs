import { css, html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { baseStyles } from "./style.ts";

@customElement("common-send-message")
export class SendMessageElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
      }

      .unibox {
        display: grid;
        grid-template-columns: 1fr min-content;
        column-gap: var(--gap);
      }
    `,
  ];

  @property({ type: String })
  name: string;

  @property({ type: String })
  placeholder: string;

  send(event: Event) {
    event.preventDefault();

    const inputEl = this.shadowRoot.getElementById("input") as HTMLInputElement;
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
          .placeholder=${this.placeholder}
          @keydown=${this.keyDown}
        >
        </common-input>
        <common-button class="unibox-button" @click=${this.send}
          >${this.name}</common-button
        >
      </div>
    `;
  }
}
