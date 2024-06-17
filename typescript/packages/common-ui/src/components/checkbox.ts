import { LitElement, html, css } from "lit-element";
import { customElement } from "lit-element/decorators.js";
import { view } from "../hyperscript/render.js";

export const checkbox = view("common-checkbox", {});

@customElement("common-checkbox")
export class CheckboxElement extends LitElement {
  static override styles = css``;

  override render() {
    return html` <input type="checkbox" /> `;
  }
}
