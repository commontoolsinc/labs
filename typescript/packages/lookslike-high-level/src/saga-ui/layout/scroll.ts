import { LitElement, html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { baseStyles } from "../style.js";

@customElement("common-scroll")
export class CommonScrollElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
    :host {
      display: block;
      height: 100%;
      width: 100%;
    }

    .scroll {
      overflow-y: auto;
      overflow-x: hidden;
      height: 100%;
      width: 100%;
      container-type: size;
      container-name: scroll;
    }
    `
  ];

  override render() {
    return html`
    <div class="scroll">
      <slot></slot>
    </div>`;
  }
}