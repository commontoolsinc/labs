import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { consume } from "@lit/context";
import { App } from "../models/app.ts";
import { appContext } from "../contexts/app.ts";

export class XHeaderView extends LitElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 50px;
      background-color: #ddd;
    }
  `;

  @consume({ context: appContext })
  @property({ attribute: false })
  app = new App();

  override render() {
    return html`
      <div id="header">
        <span></span>
      </div>
    `;
  }
}

globalThis.customElements.define("x-header-view", XHeaderView);
