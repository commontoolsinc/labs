import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseView } from "./BaseView.ts";
import { getNavigationHref } from "../lib/navigate.ts";
import { RuntimeInternals } from "../lib/runtime.ts";
import { CharmController } from "@commontools/charm/ops";

export class XCharmListView extends BaseView {
  static override styles = css`
    :host {
      display: block;
    }

    a, a:visited {
      color: var(--primary-font, "#000");
    }
  `;

  @property({ attribute: false })
  charms?: CharmController[];

  @property({ attribute: false })
  spaceName?: string;

  override render() {
    const { charms, spaceName } = this;
    if (!spaceName || !charms) {
      return html`
        <x-spinner></x-spinner>
      `;
    }

    const list = charms.map((charm) => {
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

globalThis.customElements.define("x-charm-list-view", XCharmListView);
