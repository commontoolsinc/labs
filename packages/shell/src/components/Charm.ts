import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseView } from "../views/BaseView.ts";
import { CharmsController } from "@commontools/charm/ops";
import { Task } from "@lit/task";

export class XCharmElement extends BaseView {
  static override styles = css`
    :host {
      display: block;
    }
  `;

  @property({ attribute: false })
  cc?: CharmsController;

  @property({ attribute: false })
  charmId?: string;

  private _charm = new Task(this, {
    task: async ([charmId, cc]) => {
      if (!this.charmId || !this.cc) {
        return;
      }
      return await cc!.get(charmId!);
    },
    args: () => [this.charmId, this.cc],
  });

  override render() {
    if (!this._charm.value) {
      return html`
        <x-spinner></x-spinner>
      `;
    }
    const cell = this._charm.value.getCell();
    return html`
      <ct-render .cell="${cell}"></ct-render>
    `;
  }
}

globalThis.customElements.define("x-charm", XCharmElement);
