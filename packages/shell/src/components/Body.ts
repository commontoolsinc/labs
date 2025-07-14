import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseView } from "../views/BaseView.ts";
import { CharmsController } from "@commontools/charm/ops";

export class XBodyElement extends BaseView {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      background-color: white;
      padding: 1rem;
    }
  `;

  @property({ attribute: false })
  cc?: CharmsController;

  @property({ attribute: false })
  activeCharmId?: string;

  override render() {
    const connected = this.cc ? "Connected" : "Not Connected";
    const charmView = html`
      <x-charm .cc="${this.cc}" .charmId="${this.activeCharmId}"></x-charm>
    `;
    const charmList = html`
      <x-charm-list .cc="${this.cc}"></x-charm-list>
    `;
    const view = this.activeCharmId ? charmView : charmList;
    return html`
      <div>
        <h2>App!! (${connected})</h2>
        <div>${view}</div>
      </div>
    `;
  }
}

globalThis.customElements.define("x-body", XBodyElement);
