import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseView } from "./BaseView.ts";
import { PieceController } from "@commontools/piece/ops";

export class XCharmView extends BaseView {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      height: 100%;
      min-height: 0; /* Important for flex children */
    }

    ct-charm {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }

    ct-render {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
      height: 100%;
    }
  `;

  @property({ attribute: false })
  charm?: PieceController;

  override render() {
    if (!this.charm) {
      return html`
        <x-spinner></x-spinner>
      `;
    }

    const cell = this.charm.getCell();

    return html`
      <ct-charm .pieceId="${this.charm.id}">
        <ct-render .cell="${cell}"></ct-render>
      </ct-charm>
    `;
  }
}

globalThis.customElements.define("x-charm-view", XCharmView);
