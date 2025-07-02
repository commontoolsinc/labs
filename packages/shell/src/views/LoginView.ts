import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { consume } from "@lit/context";
import { App } from "../models/app.ts";
import { appContext } from "../contexts/app.ts";

export class XLoginView extends LitElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      background-color: #ddd;
    }
  `;

  @consume({ context: appContext })
  @property({ attribute: false })
  app = new App();

  override render() {
    return html`
      <span>TODO LOGIN!</span>
    `;
  }
}

globalThis.customElements.define("x-login-view", XLoginView);
