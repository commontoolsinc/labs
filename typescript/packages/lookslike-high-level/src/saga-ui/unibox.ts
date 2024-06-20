import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { baseStyles } from "./style.js";

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
    `
  ];

  @property({ type: String }) value = "";
  @property({ type: String }) placeholder = "";
  @property({ type: String }) label = "Search";

  override render() {
    return html`
    <div class="unibox">
      <common-input
        class="unibox-input"
        .placeholder="${this.placeholder}"
        .value="${this.value}">
      </common-input>
      <common-button class="unibox-button">${this.label}</common-button>
    </div>
    `;
  }
}