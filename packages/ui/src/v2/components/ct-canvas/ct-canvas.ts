import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("ct-canvas")
export class CtCanvas extends LitElement {
  @property({ type: Number }) width = 800;
  @property({ type: Number }) height = 600;

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

  override render() {
    return html`
      <div 
        class="canvas-container"
        style="--canvas-width: ${this.width}px; --canvas-height: ${this.height}px"
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