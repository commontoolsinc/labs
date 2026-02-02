import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseView } from "./BaseView.ts";
import { PieceController } from "@commontools/piece/ops";

export class XPieceView extends BaseView {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      height: 100%;
      min-height: 0; /* Important for flex children */
    }

    ct-piece {
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
  piece?: PieceController;

  override render() {
    if (!this.piece) {
      return html`
        <x-spinner></x-spinner>
      `;
    }

    const cell = this.piece.getCell();

    return html`
      <ct-piece .pieceId="${this.piece.id}">
        <ct-render .cell="${cell}"></ct-render>
      </ct-piece>
    `;
  }
}

globalThis.customElements.define("x-piece-view", XPieceView);
