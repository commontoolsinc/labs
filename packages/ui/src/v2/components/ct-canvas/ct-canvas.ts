import { css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";

@customElement("ct-canvas")
export class CtCanvas extends BaseElement {
  @property({ type: Number })
  width = 800;
  @property({ type: Number })
  height = 600;

  static override styles = css`
    :host {
      display: block;
    }

    .canvas-container {
      position: relative;
      width: var(--canvas-width, 800px);
      height: var(--canvas-height, 600px);
      border: 1px solid #ddd;
      background: #f9f9f9;
      overflow: auto;
    }

    .canvas-container ::slotted(*) {
      position: absolute !important;
    }

    /* Position each child at different locations */
    .canvas-container ::slotted(*:nth-child(1)) {
      left: 50px;
      top: 50px;
    }

    .canvas-container ::slotted(*:nth-child(2)) {
      left: 250px;
      top: 100px;
    }

    .canvas-container ::slotted(*:nth-child(3)) {
      left: 450px;
      top: 50px;
    }

    .canvas-container ::slotted(*:nth-child(4)) {
      left: 100px;
      top: 200px;
    }

    .canvas-container ::slotted(*:nth-child(5)) {
      left: 350px;
      top: 250px;
    }

    .canvas-container ::slotted(*:nth-child(6)) {
      left: 550px;
      top: 200px;
    }

    .canvas-container ::slotted(*:nth-child(7)) {
      left: 150px;
      top: 350px;
    }

    .canvas-container ::slotted(*:nth-child(8)) {
      left: 400px;
      top: 400px;
    }

    .canvas-container ::slotted(*:nth-child(9)) {
      left: 50px;
      top: 450px;
    }

    .canvas-container ::slotted(*:nth-child(10)) {
      left: 300px;
      top: 500px;
    }
  `;

  private handleCanvasClick(event: MouseEvent) {
    // Get the canvas container element
    const container = event.currentTarget as HTMLElement;
    const rect = container.getBoundingClientRect();

    // Calculate relative position within the canvas
    const x = Math.round(event.clientX - rect.left);
    const y = Math.round(event.clientY - rect.top);

    console.log(`Canvas clicked at: x=${x}, y=${y}`);

    // Emit event using BaseElement's emit method
    this.emit("ct-canvas-click", { x, y });
  }

  override render() {
    return html`
      <div
        class="canvas-container"
        style="--canvas-width: ${this.width}px; --canvas-height: ${this
        .height}px"
        @click="${this.handleCanvasClick}"
      >
        <slot></slot>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ct-canvas": CtCanvas;
  }
}
