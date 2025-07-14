import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseView } from "../views/BaseView.ts";
import { CharmsController } from "@commontools/charm/ops";
import { Task } from "@lit/task";
import { USE_SHELL_PREFIX } from "../lib/env.ts";

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
    const spaceName = this.cc ? this.cc.manager().getSpaceName() : "No Space.";
    const charmList = this._charmList.value;
    const list = (charmList ?? []).map((charm) => {
      const name = charm.name();
      const id = charm.id;
      const href = makeHref(spaceName, id);
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

function makeHref(spaceName: string, id: string) {
  const href = `/${spaceName}/${id}`;
  return USE_SHELL_PREFIX ? `/shell${href}` : href;
}

globalThis.customElements.define("x-charm-list", XCharmListElement);
