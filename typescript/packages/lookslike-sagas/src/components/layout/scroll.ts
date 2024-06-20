import { LitElement, html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { baseStyles } from "../style.js";

@customElement("common-scroll")
export class ScrollElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
    :host {
      display: block;
    }

    .scroll {
      overflow-y: auto;
      overflow-x: hidden;
      height: 100cqh;
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