import { css, html, LitElement } from "lit";
import { baseStyles } from "./style.ts";

export class CommonUniboxElement extends LitElement {
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

  static override properties = {
    value: { type: String },
    placeholder: { type: String },
    label: { type: String },
  };

  declare value: string;
  declare placeholder: string;
  declare label: string;

  constructor() {
    super();
    this.value = "";
    this.placeholder = "";
    this.label = "Search";
  }

  private handleClick(e: Event & { shiftKey: boolean }) {
    const event = new CustomEvent("submit", {
      bubbles: true,
      composed: true,
      detail: { value: this.value, shiftHeld: e.shiftKey },
    });
    this.dispatchEvent(event);
    this.value = "";
  }

  private handleChange(event: Event) {
    const target = event.target as HTMLInputElement;
    this.value = target.value;
  }

  private handleEnter(event: KeyboardEvent) {
    if (event.key === "Enter") {
      this.handleClick(event);
    }
  }

  override render() {
    return html`
      <div class="unibox">
        <common-input
          appearance="rounded"
          class="unibox-input"
          .placeholder="${this.placeholder}"
          .value="${this.value}"
          @input=${this.handleChange}
          @keydown=${this.handleEnter}
        >
        </common-input>
        <common-button class="unibox-button" @click=${this.handleClick}
          >${this.label}</common-button
        >
      </div>
    `;
  }
}
globalThis.customElements.define("common-unibox", CommonUniboxElement);
