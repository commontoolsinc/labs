import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { baseStyles } from "./style.js";
import { view } from "../hyperscript/render.js";

export const list = view("common-list", {});

@customElement("common-list")
export class CommonListElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        height: 100%;
        width: 100%;
      }
    `,
  ];

  @property({ type: String }) gap: string = "md";
  @property({ type: String }) pad: string = "md";

  override render() {
    return html`
      <common-scroll>
        <common-vstack gap="${this.gap}" pad="${this.pad}">
          <slot></slot>
        </common-vstack>
      </common-scroll>
    `;
  }
}
