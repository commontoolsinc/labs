import { LitElement, html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { baseStyles } from "../style.js";

@customElement("common-button")
export class ButtonElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
    :host {
      --button-background: #000;
      --button-color: #fff;
      --height: 40px;
      background-color: var(--button-background);
      box-sizing: border-box;
      border-radius: calc(var(--height) / 2);
      color: var(--button-color);
      height: var(--height);
      display: flex;
      align-items: center;
      line-height: 20px;
      padding: 8px 20px;
    }
    `
  ];

  override render() {
    return html`<slot></slot>`;
  }
}