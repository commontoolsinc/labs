import { css, html } from "lit";
import { Task } from "@lit/task";
import { state } from "lit/decorators.js";
import { AppState } from "../lib/app/mod.ts";
import { appContext } from "../contexts/app.ts";
import { consume } from "@lit/context";
import { BaseView } from "./BaseView.ts";
import { createCharmsController } from "../lib/runtime.ts";

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

  private _cc = new Task(this, {
    task: async ([app]) => {
      console.log("TASK START", app);
      if (!app || !app.identity || !app.spaceName || !app.apiUrl) {
        return undefined;
      }
      console.log("TASK RUN");
      return await createCharmsController({
        identity: app.identity,
        spaceName: app.spaceName,
        apiUrl: app.apiUrl,
      });
    },
    args: () => [this.app],
  });

  override render() {
    const cc = this._cc.value;
    console.log("app view", cc);
    const app = (this.app ?? {}) as AppState;
    const activeCharmId = Math.random() + ""; //app.activeCharmId;
    console.log("ACI", activeCharmId);
    const unauthenticated = html`
      <x-login-view></x-login-view>
    `;
    const authenticated = this._cc.render({
      pending: () => html`
        <div>
          <x-header .identity="${app.identity}"></x-header>
          <x-body .cc="${undefined}" .activeCharmId="${activeCharmId}"></x-body>
        </div>
      `,
      complete: (cc) => html`
        <div>
          <x-header .identity="${app.identity}"></x-header>
          <x-body .cc="${cc}" .activeCharmId="${activeCharmId}"></x-body>
        </div>
      `
    });
    return this.app?.identity ? authenticated : unauthenticated;
  }
}

globalThis.customElements.define("x-app-view", XAppView);
