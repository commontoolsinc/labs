import { LitElement, css, html } from "lit-element";
import { customElement } from "lit/decorators.js";
import { base } from "../shared/styles.js";

@customElement("os-icon-button")
export class OsIconButton extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        display: inline-block;
        --u-button-size: var(--u-min-touch-size);
      }

      .icon-button {
        display: block;
        cursor: pointer;
        border: 0;
        --webkit-appearance: none;
        appearance: none;
        background-color: var(--bg-3);
        border-radius: var(--u-radius);
        width: var(--u-button-size);
        height: var(--u-button-size);
        overflow: hidden;
        position: relative;
      }

      .icon-button::before {
        content: "";
        background-color: var(--bg-scrim);
        width: var(--u-button-size);
        height: var(--u-button-size);
        top: 0;
        left: 0;
        opacity: 0;
        position: absolute;
        pointer-events: none;
      }

      .icon-button:active::before {
        opacity: 1;
      }
    `,
  ];

  override render() {
    return html`
      <button class="icon-button">
        <slot></slot>
      </button>
    `;
  }
}
