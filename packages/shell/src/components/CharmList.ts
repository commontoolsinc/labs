import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseView } from "../views/BaseView.ts";
import { CharmsController } from "@commontools/charm/ops";
import { Task } from "@lit/task";
import { getNavigationHref } from "../lib/navigate.ts";

export class XCharmListElement extends BaseView {
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

  private _charmList = new Task(this, {
    task: ([cc]) => {
      return cc ? cc.getAllCharms() : undefined;
    },
    args: () => [this.cc],
  });

  override render() {
    const spaceName = this.cc ? this.cc.manager().getSpaceName() : undefined;
    const charmList = this._charmList.value;

    if (!spaceName || !charmList) {
      return html`
        <x-spinner></x-spinner>
      `;
    }

    const list = (charmList ?? []).map((charm) => {
      const name = charm.name();
      const id = charm.id;
      const href = getNavigationHref(spaceName, id);
      return html`
        <li><a href="${href}">${name}</a></li>
      `;
    });
    return html`
      <h3>${spaceName}</h3>
      <ul>${list}</ul>
    `;
  }
}

globalThis.customElements.define("x-charm-list", XCharmListElement);
