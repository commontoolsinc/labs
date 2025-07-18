import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseView } from "./BaseView.ts";
import { RuntimeInternals } from "../lib/runtime.ts";
import { Task } from "@lit/task";

export class XCharmView extends BaseView {
  static override styles = css`
    :host {
      display: block;
    }
  `;

  @property({ attribute: false })
  rt?: RuntimeInternals;

  @property({ attribute: false })
  charmId?: string;

  private _charm = new Task(this, {
    task: async ([charmId, rt]) => {
      if (!charmId || !rt) {
        return;
      }
      return await rt.cc().get(charmId!);
    },
    args: () => [this.charmId, this.rt],
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

globalThis.customElements.define("x-charm-view", XCharmView);
