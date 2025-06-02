import { css, html, LitElement } from "lit";

export class CommonScreenElement extends LitElement {
  static override styles = css`
    :host {
      display: block;
      container-type: size;
      container-name: screen;
      width: 100vw;
      height: 100vh;
    }
  `;

  override render() {
    return html`
      <slot></slot>
    `;
  }
}
globalThis.customElements.define("common-screen", CommonScreenElement);
