import { css, html } from "lit";
import { property } from "lit/decorators.js";

import { AppState } from "../lib/app/mod.ts";
import { BaseView } from "./BaseView.ts";
import { KeyStore } from "@commontools/identity";
import { RuntimeInternals } from "../lib/runtime.ts";

export class XAppView extends BaseView {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
    }

    .shell-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      background-color: white;
      border: var(--border-width, 2px) solid var(--border-color, #000);
    }

    .content-area {
      flex: 1;
      overflow-y: auto;
      background-color: white;
    }
  `;

  @property({ attribute: false })
  private app?: AppState;

  @property({ attribute: false })
  private rt?: RuntimeInternals;

  @property({ attribute: false })
  private keyStore?: KeyStore;

  private handleToggleShellCharmListView = (e: Event) => {
    const customEvent = e as CustomEvent;
    this.command({
      type: "set-shell-charm-list-view",
      show: customEvent.detail.show,
    });
  };

  override render() {
    const app = (this.app ?? {}) as AppState;
    const unauthenticated = html`
      <x-login-view .keyStore="${this.keyStore}"></x-login-view>
    `;
    const authenticated = html`
      <x-body-view
        .rt="${this.rt}"
        .activeCharmId="${app.activeCharmId}"
        .showShellCharmListView="${app.showShellCharmListView ?? false}"
      ></x-body-view>
    `;

    const content = this.app?.identity ? authenticated : unauthenticated;
    return html`
      <div class="shell-container">
        <x-header-view
          .identity="${app.identity}"
          .spaceName="${app.spaceName}"
          .rt="${this.rt}"
          .keyStore="${this.keyStore}"
          .charmId="${app.activeCharmId}"
          .showShellCharmListView="${app.showShellCharmListView ?? false}"
          @toggle-shell-charm-list-view="${this.handleToggleShellCharmListView}"
        ></x-header-view>
        <div class="content-area">
          ${content}
        </div>
      </div>
    `;
  }
}

globalThis.customElements.define("x-app-view", XAppView);
