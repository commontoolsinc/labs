import { LitElement, html, css } from "lit";
import { customElement } from "lit/decorators.js";
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

  override render() {
    return html`
      <common-scroll>
        <common-vstack gap="md" pad="md">
          <slot></slot>
        </common-vstack>
      </common-scroll>
    `;
  }
}
