import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { navigate, NavigationCommandType } from "../lib/navigate.ts";

export class CharmLinkElement extends LitElement {
  static override styles = css`
    a, a:visited {
      color: var(--primary-font, "#000");
    }
  `;

  @property()
  charmId?: string;

  @property()
  spaceName?: string;

  #onClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (!this.spaceName) {
      throw new Error("Cannot navigate with space name.");
    }
    if (this.charmId) {
      navigate({
        type: "charm",
        spaceName: this.spaceName,
        charmId: this.charmId,
      });
    } else {
      navigate({
        type: "space",
        spaceName: this.spaceName,
      });
    }
  };

  override render() {
    return html`
      <a class="charm-link" href="#" @click="${this.#onClick}"><slot></slot></a>
    `;
  }
}

globalThis.customElements.define("x-charm-link", CharmLinkElement);
