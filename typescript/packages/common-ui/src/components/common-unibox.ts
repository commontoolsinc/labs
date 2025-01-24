import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { baseStyles } from "./style.ts";

@customElement("common-unibox")
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

  accessor value: string = "";
  accessor placeholder: string = "";
  accessor label: string = "Search";

  private handleClick(e: Event & { shiftKey: boolean }) {
    const event = new CustomEvent('submit', {
      bubbles: true,
      composed: true,
      detail: { value: this.value, shiftHeld: e.shiftKey }
    });
    this.dispatchEvent(event);
    this.value = '';
  }

  private handleChange(event: Event) {
    const target = event.target as HTMLInputElement;
    this.value = target.value;
  }

  private handleEnter(event: KeyboardEvent) {
    if (event.key === 'Enter') {
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
        <common-button class="unibox-button" @click=${this.handleClick}>${this.label}</common-button>
      </div>
    `;
  }
}
