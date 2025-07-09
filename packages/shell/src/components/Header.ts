import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { Identity } from "@commontools/identity";

export class XHeaderElement extends LitElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 50px;
      background-color: #ddd;
    }
  `;

  @property({ attribute: false })
  identity?: Identity;

  override render() {
    const did = this.identity ? this.identity.did() : undefined;
    return html`
      <div id="header">
        <span>${did}</span>
      </div>
    `;
  }
}

globalThis.customElements.define("x-header", XHeaderElement);
