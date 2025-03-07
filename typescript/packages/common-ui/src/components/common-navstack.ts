import { css, html, LitElement } from "lit";

export class CommonNavstackElement extends LitElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }

    .navstack {
      position: relative;
      height: 100%;
      width: 100%;
    }
    .navstack ::slotted(*) {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      right: 0;
      opacity: 0;
    }

    .navstack ::slotted(*:first-child) {
      opacity: 1;
    }
  `;

  override render() {
    return html`
      <div class="navstack">
        <slot></slot>
      </div>
    `;
  }
}
globalThis.customElements.define("common-navstack", CommonNavstackElement);
