import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseView } from "./BaseView.ts";
import { RuntimeInternals } from "../lib/runtime.ts";
import { CharmController } from "@commontools/charm/ops";
import { type DID } from "@commontools/identity";

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
  spaceDid?: DID;

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
    const { charms, spaceName, spaceDid } = this;
    if (!charms) {
      return html`
        <x-spinner></x-spinner>
      `;
    }

    const displayName = spaceName ?? "Home";
    const list = charms.map((charm) => {
      const name = charm.name() ?? "Untitled Charm";
      const id = charm.id;
      return html`
        <li class="charm-item">
          <x-charm-link
            .charmId="${id}"
            .spaceName="${spaceName}"
            .spaceDid="${spaceDid}"
          >${name}</x-charm-link>
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
      <h3>${displayName}</h3>
      ${spaceName
        ? html`
          <x-acl-view .rt="${this.rt}"></x-acl-view>
        `
        : null}
      <ul>${list}</ul>
    `;
  }
}

globalThis.customElements.define("x-charm-list-view", XCharmListView);
