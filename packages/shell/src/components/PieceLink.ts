import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { type DID } from "@commontools/identity";
import { navigate } from "../../shared/mod.ts";

export class PieceLinkElement extends LitElement {
  static override styles = css`
    a, a:visited {
      color: var(--primary-font, "#000");
    }
  `;

  @property()
  pieceId?: string;

  @property()
  spaceName?: string;

  @property({ attribute: false })
  spaceDid?: DID;

  #onClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (this.spaceName) {
      navigate(
        this.pieceId
          ? { spaceName: this.spaceName, pieceId: this.pieceId }
          : { spaceName: this.spaceName },
      );
    } else if (this.spaceDid) {
      navigate(
        this.pieceId
          ? { spaceDid: this.spaceDid, pieceId: this.pieceId }
          : { spaceDid: this.spaceDid },
      );
    } else {
      throw new Error("Cannot navigate without space name or DID.");
    }
  };

  asHref(): string {
    if (this.spaceName) {
      return `/${this.spaceName}${this.pieceId ? `/${this.pieceId}` : ""}`;
    }
    if (this.spaceDid) {
      return `/${this.spaceDid}${this.pieceId ? `/${this.pieceId}` : ""}`;
    }
    return "/";
  }

  override render() {
    const href = this.asHref();
    return html`
      <a class="piece-link" href="${href}" @click="${this
        .#onClick}"><slot></slot></a>
    `;
  }
}

globalThis.customElements.define("x-piece-link", PieceLinkElement);
