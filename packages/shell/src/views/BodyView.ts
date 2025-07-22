import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { BaseView } from "./BaseView.ts";
import { RuntimeInternals } from "../lib/runtime.ts";

export class XBodyView extends BaseView {
  static override styles = css`
    :host {
      display: block;
      padding: 1rem;
      overflow: hidden;
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    globalThis.addEventListener("toggle-view", this.handleToggleView);
  }

  override disconnectedCallback() {
    globalThis.removeEventListener("toggle-view", this.handleToggleView);
    super.disconnectedCallback();
  }

  private handleToggleView = (e: Event) => {
    const customEvent = e as CustomEvent;
    this.showCharmList = customEvent.detail.showCharmList;
    this.requestUpdate();
  };

  @property({ attribute: false })
  rt?: RuntimeInternals;

  @property({ attribute: false })
  activeCharmId?: string;

  @state()
  showCharmList = false;

  override render() {
    const charmView = html`
      <x-charm-view .rt="${this.rt}" .charmId="${this
        .activeCharmId}"></x-charm-view>
    `;
    const spaceView = html`
      <x-space-view .rt="${this.rt}" .showCharmList="${this
        .showCharmList}"></x-space-view>
    `;
    const view = this.activeCharmId ? charmView : spaceView;
    return html`
      <div>${view}</div>
    `;
  }
}

globalThis.customElements.define("x-body-view", XBodyView);
