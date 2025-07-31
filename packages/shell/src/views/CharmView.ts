import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseView } from "./BaseView.ts";
import { RuntimeInternals } from "../lib/runtime.ts";
import { CharmController } from "@commontools/charm/ops";

export class XCharmView extends BaseView {
  static override styles = css`
    :host {
      display: block;
    }
  `;

  @property({ attribute: false })
  rt?: RuntimeInternals;

  @property({ attribute: false })
  charm?: CharmController;

  override render() {
    if (!this.charm) {
      return html`
        <x-spinner></x-spinner>
      `;
    }
    const cell = this.charm.getCell();
    return html`
      <ct-render .cell="${cell}"></ct-render>
    `;
  }
}

globalThis.customElements.define("x-charm-view", XCharmView);
