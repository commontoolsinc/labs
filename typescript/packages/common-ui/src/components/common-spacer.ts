import { LitElement, css } from "lit";
import { customElement } from "lit/decorators.js";

@customElement("common-spacer")
export class CommonSpacerElement extends LitElement {
  static override styles = css`
    :host {
      display: block;
      flex-grow: 999;
      flex-shrink: 999;
    }
  `;
}
