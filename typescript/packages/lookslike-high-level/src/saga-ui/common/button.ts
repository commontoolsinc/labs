import { LitElement, html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { baseStyles } from "../style.js";

@customElement("common-button")
export class CommonButtonElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
    :host {
      --button-background: #000;
      --button-color: #fff;
      --height: 40px;
      align-items: center;
      background-color: var(--button-background);
      box-sizing: border-box;
      border-radius: calc(var(--height) / 2);
      color: var(--button-color);
      display: flex;
      font-size: var(--body-size);
      height: var(--height);
      line-height: 20px;
      padding: 8px 20px;
    }
    `
  ];

  override render() {
    return html`<slot></slot>`;
  }
}