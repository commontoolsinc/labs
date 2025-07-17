import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseView } from "../views/BaseView.ts";
import { CharmsController } from "@commontools/charm/ops";

export class XBodyElement extends BaseView {
  static override styles = css`
    :host {
      display: block;
      padding: 1rem;
      overflow: hidden;
    }
  `;

  @property({ attribute: false })
  cc?: CharmsController;

  @property({ attribute: false })
  activeCharmId?: string;

  override render() {
    const charmView = html`
      <x-charm .cc="${this.cc}" .charmId="${this.activeCharmId}"></x-charm>
    `;
    const spaceView = html`
      <x-space .cc="${this.cc}"></x-space>
    `;
    const view = this.activeCharmId ? charmView : spaceView;
    return html`
      <div>${view}</div>
    `;
  }
}

globalThis.customElements.define("x-body", XBodyElement);
