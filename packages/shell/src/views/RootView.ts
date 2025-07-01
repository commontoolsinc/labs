import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { provide } from "@lit/context";
import { App } from "../models/app.ts";
import { appContext } from "../contexts/app.ts";
import { Runtime } from "@commontools/runner";

// @ts-ignore Use Runtime to test bundling
globalThis.runtime = Runtime;

export class XRootView extends LitElement {
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

  @provide({ context: appContext })
  app = new App();

  constructor() {
    super();
  }

  override render() {
    const unauthenticated = html`
      <x-login-view></x-login-view>
    `;
    const authenticated = html`
      <x-header-view></x-header-view>
      <x-body-view></x-body-view>
    `;
    return this.app.identity ? authenticated : unauthenticated;
  }
}

globalThis.customElements.define("x-root-view", XRootView);
