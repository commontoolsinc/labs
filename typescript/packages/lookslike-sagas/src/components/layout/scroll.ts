import { LitElement, html, css } from "lit";
import {customElement} from "lit/decorators.js";

@customElement("common-scroll")
export class ScrollViewElement extends LitElement {
  static override styles = css`
  :host {
    display: block;
  }
  .scroll {
    overflow-y: auto;
    overflow-x: hidden;
    height: 100cqh;
  }
  `;

  override render() {
    return html`
    <div class="scroll">
      <slot></slot>
    </div>`;
  }
}