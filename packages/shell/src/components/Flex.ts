import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";

type FlexDirection = "horizontal" | "vertical";

export class XFlexElement extends LitElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }

    div {
      display: flex;
      flex-direction: row;
    }

    div[center] {
      align-items: center;
    }

    div[flex-direction="vertical"] {
      flex-direction: column;
    }

    ::slotted(*) {
      flex: 1;
    }
  `;

  @property()
  center = false;

  @property()
  direction: FlexDirection = "horizontal";

  override render() {
    return html`
      <div ?center="${this.center}" flex-direction="${this
        .direction}"><slot></slot></div>
    `;
  }
}

export class HBoxElement extends LitElement {
  @property()
  center = false;

  direction = "horizontal";

  override render() {
    return html`
      <x-flex .center="${this.center}" direction="${this
        .direction}"><slot></slot></x-flex>
    `;
  }
}

export class VBoxElement extends HBoxElement {
  override direction = "vertical";
}

globalThis.customElements.define("x-flex", XFlexElement);
globalThis.customElements.define("h-box", HBoxElement);
globalThis.customElements.define("v-box", VBoxElement);
