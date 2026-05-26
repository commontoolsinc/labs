import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { type DID } from "@commonfabric/identity";
import {
  AppView,
  appViewToUrlPath,
  navigate,
  preserveAppViewMode,
  urlToAppView,
} from "../../shared/mod.ts";

export class PieceLinkElement extends LitElement {
  static override styles = css`
    a, a:visited {
      color: var(--primary-font, "#000");
    }
  `;

  @property()
  accessor pieceId: string | undefined = undefined;

  @property()
  accessor spaceName: string | undefined = undefined;

  @property({ attribute: false })
  accessor spaceDid: DID | undefined = undefined;

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

  asView(): AppView {
    if (this.spaceName) {
      return this.pieceId
        ? { spaceName: this.spaceName, pieceId: this.pieceId }
        : { spaceName: this.spaceName };
    }
    if (this.spaceDid) {
      return this.pieceId
        ? { spaceDid: this.spaceDid, pieceId: this.pieceId }
        : { spaceDid: this.spaceDid };
    }
    return { builtin: "home" };
  }

  asHref(): string {
    return appViewToUrlPath(
      preserveAppViewMode(
        urlToAppView(new URL(globalThis.location.href)),
        this.asView(),
      ),
    );
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
