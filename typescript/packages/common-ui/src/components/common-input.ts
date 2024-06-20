import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { baseStyles } from "./style.js";

@customElement("common-input")
export class CommonInputElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
    :host {
      --height: 40px;
    }
    
    .input {
      appearance: none;
      background-color: var(--input-background);
      border: 0;
      border-radius: calc(var(--height) / 2);
      box-sizing: border-box;
      font-size: var(--body-size);
      width: 100%;
      height: 100%;
      padding: 8px 16px;
      height: var(--height);
    }
    `
  ];

  @property({ type: String }) value = "";
  @property({ type: String }) placeholder = "";

  override render() {
    return html`
    <input
      class="input"
      .value="${this.value}"
      .placeholder="${this.placeholder}"
      type="text" />`;
  }
}