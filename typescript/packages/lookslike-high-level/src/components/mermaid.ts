import { LitElement, html, css } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import mermaid from "mermaid";
import panzoom from "panzoom";

@customElement("common-mermaid")
export default class MermaidElement extends LitElement {
  @property({ type: String }) diagram = "";

  private panzoomInstance: ReturnType<typeof panzoom> | null = null;

  static override  styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      min-height: 300px;
      position: relative;
      overflow: hidden;
    }

    .container {
      position: absolute;
      width: 100%;
      height: 100%;
    }

    .mermaid-content {
      position: absolute;
      width: fit-content;
      height: fit-content;
      min-width: 100px;
      min-height: 100px;
    }

    .controls {
      position: absolute;
      bottom: 10px;
      right: 10px;
      z-index: 1;
      display: flex;
      gap: 8px;
    }

    button {
      padding: 8px;
      border: none;
      background: rgba(0, 0, 0, 0.6);
      color: white;
      border-radius: 4px;
      cursor: pointer;
    }

    button:hover {
      background: rgba(0, 0, 0, 0.8);
    }
  `;

  constructor() {
    super();
    mermaid.initialize({
      startOnLoad: false,
      theme: "default",
      er: {
        useMaxWidth: true
      }
    });
  }

  override firstUpdated() {
    this.renderMermaid();
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    if (changedProperties.has("diagram")) {
      this.renderMermaid();
    }
  }

  async renderMermaid() {
    const container = this.shadowRoot?.querySelector(".mermaid-content");
    if (!container || !this.diagram) return;

    try {
      const { svg } = await mermaid.render("mermaid-graph", this.diagram);
      container.innerHTML = svg;

      // Ensure the SVG takes up space
      const svgElement = container.querySelector('svg');
      if (svgElement) {
        svgElement.style.width = '100%';
        svgElement.style.height = '100%';
      }

      // Wait for the SVG to be added to the DOM before initializing panzoom
      requestAnimationFrame(() => {
        this.initializePanzoom();
        this.fitContent();
      });
    } catch (error) {
      console.error("Failed to render mermaid diagram:", error);
      container.innerHTML = "<p>Failed to render diagram</p>";
    }
  }

  private initializePanzoom() {
    const container = this.shadowRoot?.querySelector(".mermaid-content");
    if (!container) return;

    if (this.panzoomInstance) {
      this.panzoomInstance.dispose();
    }

    this.panzoomInstance = panzoom(container as HTMLElement, {
      maxZoom: 5,
      minZoom: 0.1,
      bounds: true,
      boundsPadding: 0.1
    });
  }

  private fitContent() {
    const container = this.shadowRoot?.querySelector(".container");
    const content = this.shadowRoot?.querySelector(".mermaid-content");
    if (!container || !content) return;

    const containerRect = container.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();

    const scaleX = containerRect.width / contentRect.width;
    const scaleY = containerRect.height / contentRect.height;
    const scale = Math.min(scaleX, scaleY, 1);

    if (this.panzoomInstance) {
      this.panzoomInstance.zoomAbs(0, 0, scale * 2.0); // 90% of perfect fit to add some padding
      this.panzoomInstance.moveTo(0, 0);
    }
  }

  private resetView() {
    if (this.panzoomInstance) {
      this.fitContent();
    }
  }

  private zoomIn() {
    if (this.panzoomInstance) {
      this.panzoomInstance.smoothZoom(0, 0, 1.5);
    }
  }

  private zoomOut() {
    if (this.panzoomInstance) {
      this.panzoomInstance.smoothZoom(0, 0, 0.667);
    }
  }

  override render() {
    return html`
      <div class="container">
        <div class="mermaid-content"></div>
      </div>
      <div class="controls">
        <button @click=${this.zoomIn}>+</button>
        <button @click=${this.zoomOut}>-</button>
        <button @click=${this.resetView}>Reset</button>
      </div>
    `;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.panzoomInstance) {
      this.panzoomInstance.dispose();
    }
  }
}
