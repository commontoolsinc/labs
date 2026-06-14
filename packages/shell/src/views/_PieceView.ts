import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseView } from "./BaseView.ts";
import { PieceController } from "@commonfabric/piece/ops";

export class XPieceView extends BaseView {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      height: 100%;
      min-height: 0; /* Important for flex children */
    }

    cf-piece {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }

    cf-render {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
      height: 100%;
    }
  `;

  @property({ attribute: false })
  accessor piece: PieceController | undefined = undefined;

  override render() {
    if (!this.piece) {
      return html`
        <x-spinner></x-spinner>
      `;
    }

    const cell = this.piece.getCell();

    return html`
      <cf-piece .pieceId="${this.piece.id}">
        <cf-render .cell="${cell}"></cf-render>
      </cf-piece>
    `;
  }
}

globalThis.customElements.define("x-piece-view", XPieceView);
