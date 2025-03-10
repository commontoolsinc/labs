import { css, LitElement } from "lit";

export class CommonSpacerElement extends LitElement {
  static override styles = css`
    :host {
      display: block;
      flex-grow: 999;
      flex-shrink: 999;
    }
  `;
}
globalThis.customElements.define("common-spacer", CommonSpacerElement);
