import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { navigate } from "../lib/navigate.ts";
import { type DID } from "@commontools/identity";

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

  @property({ attribute: false })
  spaceDid?: DID;

  #onClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (this.spaceName) {
      navigate(
        this.charmId
          ? { spaceName: this.spaceName, charmId: this.charmId }
          : { spaceName: this.spaceName },
      );
    } else if (this.spaceDid) {
      navigate(
        this.charmId
          ? { spaceDid: this.spaceDid, charmId: this.charmId }
          : { spaceDid: this.spaceDid },
      );
    } else {
      throw new Error("Cannot navigate without space name or DID.");
    }
  };

  asHref(): string {
    if (this.spaceName) {
      return `/${this.spaceName}${this.charmId ? `/${this.charmId}` : ""}`;
    }
    if (this.spaceDid) {
      return `/${this.spaceDid}${this.charmId ? `/${this.charmId}` : ""}`;
    }
    return "/";
  }

  override render() {
    const href = this.asHref();
    return html`
      <a class="charm-link" href="${href}" @click="${this
        .#onClick}"><slot></slot></a>
    `;
  }
}

globalThis.customElements.define("x-charm-link", CharmLinkElement);
