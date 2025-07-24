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

    ul {
      list-style: none;
      padding: 0;
      margin: 0;
    }

    a, a:visited {
      color: var(--primary-font, "#000");
    }

    .charm-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.5rem 0;
      border-bottom: 1px solid #eee;
    }

    .charm-item:last-child {
      border-bottom: none;
    }

    .charm-link {
      flex: 1;
      text-decoration: none;
      padding: 0.5rem 0;
    }

    .charm-link:hover {
      text-decoration: underline;
    }

    .remove-button {
      margin-left: 1rem;
    }
  `;

  @property({ attribute: false })
  charms?: CharmController[];

  @property({ attribute: false })
  spaceName?: string;

  @property({ attribute: false })
  rt?: RuntimeInternals;

  async handleRemove(charmId: string) {
    if (!this.rt) {
      console.error("Runtime not available");
      return;
    }

    try {
      const removed = await this.rt.cc().remove(charmId);
      if (removed) {
        this.dispatchEvent(
          new CustomEvent("charm-removed", {
            detail: { charmId },
            bubbles: true,
            composed: true,
          }),
        );
      }
    } catch (error) {
      console.error("Failed to remove charm:", error);
    }
  }

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
        <li class="charm-item">
          <a class="charm-link" href="${href}">${name}</a>
          <x-button
            class="remove-button"
            size="small"
            @click="${() => this.handleRemove(id)}"
            title="Remove ${name}"
          >
            Remove
          </x-button>
        </li>
      `;
    });
    return html`
      <h3>${spaceName}</h3>
      <ul>${list}</ul>
    `;
  }
}

globalThis.customElements.define("x-charm-list-view", XCharmListView);
