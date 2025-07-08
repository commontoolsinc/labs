import { css, html } from "lit";
import { ANYONE, Identity } from "@commontools/identity";
import { BaseView } from "./BaseView.ts";

export class XLoginView extends BaseView {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      background-color: #ddd;
    }
  `;

  async onLogin(e: Event) {
    e.preventDefault();
    const identity = await Identity.fromPassphrase(ANYONE);
    this.command({ type: "set-identity", identity });
  }

  override render() {
    return html`
      <button @click="${this.onLogin}">Anonymous Login</button>
    `;
  }
}

globalThis.customElements.define("x-login-view", XLoginView);
