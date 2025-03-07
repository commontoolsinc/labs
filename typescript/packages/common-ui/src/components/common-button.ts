import { css, html, LitElement } from "lit";
import { baseStyles } from "./style.ts";

export class CommonButtonElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
      :host {
        --button-background: #000;
        --button-color: #fff;
        --button-height: 40px;
        display: block;
      }

      .button {
        align-items: center;
        appearance: none;
        background-color: var(--button-background);
        border: 0;
        box-sizing: border-box;
        border-radius: calc(var(--button-height) / 2);
        color: var(--button-color);
        cursor: pointer;
        display: flex;
        font-size: var(--body-size);
        height: var(--button-height);
        justify-content: center;
        overflow: hidden;
        line-height: 20px;
        padding: 8px 20px;
        text-align: center;
        text-wrap: nowrap;
        width: 100%;
      }
    `,
  ];

  override render() {
    return html`
      <button class="button">
        <slot></slot>
      </button>
    `;
  }
}

globalThis.customElements.define("common-button", CommonButtonElement);
