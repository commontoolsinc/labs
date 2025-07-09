import { css, html } from "lit";
import { state } from "lit/decorators.js";
import { AppState } from "../lib/app/mod.ts";
import { appContext } from "../contexts/app.ts";
import { consume } from "@lit/context";
import { BaseView } from "./BaseView.ts";

export class XAppView extends BaseView {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100vh;
      background-color: #eee;
    }
    #body {
      height: 100%;
      width: 100%;
    }
  `;

  @consume({ context: appContext, subscribe: true })
  @state()
  private app?: AppState;

  override render() {
    const unauthenticated = html`
      <x-login-view></x-login-view>
    `;
    const authenticated = html`
      <x-header-view></x-header-view>
      <x-body-view></x-body-view>
    `;
    return this.app?.identity ? authenticated : unauthenticated;
  }
}

globalThis.customElements.define("x-app-view", XAppView);
