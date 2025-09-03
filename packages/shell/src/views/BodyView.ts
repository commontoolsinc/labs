import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseView } from "./BaseView.ts";
import { RuntimeInternals } from "../lib/runtime.ts";
import { CharmController } from "@commontools/charm/ops";

export class XBodyView extends BaseView {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      padding: 1rem;
      box-sizing: border-box;
    }

    div {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0; /* Important for flex children */
    }

    x-charm-view,
    x-space-view {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
  `;

  @property({ attribute: false })
  rt?: RuntimeInternals;

  @property({ attribute: false })
  activeCharm?: CharmController;

  @property()
  showShellCharmListView = false;

  override render() {
    const charmView = html`
      <x-charm-view .rt="${this.rt}" .charm="${this
        .activeCharm}"></x-charm-view>
    `;
    const spaceView = html`
      <x-space-view
        .rt="${this.rt}"
        .showShellCharmListView="${this
          .showShellCharmListView}"
      ></x-space-view>
    `;
    const view = this.activeCharm ? charmView : spaceView;
    return html`
      <div>${view}</div>
    `;
  }
}

globalThis.customElements.define("x-body-view", XBodyView);
