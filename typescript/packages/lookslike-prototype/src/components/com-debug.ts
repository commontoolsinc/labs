import { html, css, LitElement } from "lit";
import { customElement, query, state } from "lit/decorators.js";

@customElement("com-debug")
export default class DebugWindow extends LitElement {
  @state()
  private minimized: boolean = false;

  @state()
  private width: number = 300;

  @state()
  private height: number = 400;

  @query(".content")
  private content!: HTMLElement;

  private offsetX: number = 0;
  private offsetY: number = 0;

  private initialX: number = 0;
  private initialY: number = 0;

  private resizeObserver: ResizeObserver;

  static styles = css`
    :host {
      position: fixed;
      top: 10px;
      right: 10px;
      min-width: 256px;
      min-height: 128px;
      background: rgba(0, 0, 0, 0.8);
      color: white;
      font-size: 8px;
      line-height: 10px;
      border: 1px solid #444;
      border-radius: 4px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      box-shadow: 0 0 10px rgba(0, 0, 0, 0.5);
      resize: both;
    }
    header {
      background: #222;
      padding: 4px 8px;
      cursor: move;
      display: flex;
      justify-content: space-between;
      align-items: center;
      user-select: none;
      font-family: monospace;
    }
    header .actions {
      display: flex;
      gap: 4px;
    }
    header .actions button {
      background: none;
      border: none;
      color: white;
      cursor: pointer;
    }
    .content {
      overflow-y: auto;
      max-height: 100%;
      padding: 8px;
    }
    .minimized {
      display: none;
    }
  `;
  interval: NodeJS.Timeout;

  constructor() {
    super();
    this.resizeObserver = new ResizeObserver(() => this.resizeWindow());
  }

  connectedCallback() {
    super.connectedCallback();
    this.resizeObserver.observe(this);
    this.resizeWindow();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.resizeObserver.unobserve(this);
  }

  private toggleMinimize() {
    this.minimized = !this.minimized;
    if (this.minimized) {
      this.style.width = "256px";
      this.style.height = "128px";
      this.style.top = "10px";
      this.style.right = "10px";
    } else {
      this.style.width = `${this.width}px`;
      this.style.height = `${this.height}px`;
      this.style.top = `${this.initialX}px`;
      this.style.right = `${this.initialY}px`;
    }
  }

  private startDrag(event: MouseEvent) {
    const header = this.shadowRoot?.querySelector("header");
    if (header && header.contains(event.target as Node)) {
      this.offsetX = event.clientX - this.getBoundingClientRect().left;
      this.offsetY = event.clientY - this.getBoundingClientRect().top;
      document.addEventListener("mousemove", this.drag);
      document.addEventListener("mouseup", this.stopDrag);
    }
  }

  private drag = (event: MouseEvent) => {
    const left = event.clientX - this.offsetX;
    const top = event.clientY - this.offsetY;

    this.style.left = `${left}px`;
    this.style.top = `${top}px`;
    console.log("dragging", left, top);
  };

  private stopDrag = () => {
    document.removeEventListener("mousemove", this.drag);
    document.removeEventListener("mouseup", this.stopDrag);
    this.initialX = parseInt(this.style.top, 10);
    this.initialY = parseInt(this.style.left, 10);
  };

  private resizeWindow() {
    const newWidth = this.clientWidth < 150 ? 150 : this.clientWidth;
    const newHeight = this.clientHeight < 32 ? 32 : this.clientHeight;
    this.width = newWidth;
    this.height = newHeight;
    this.style.setProperty("--width", `${newWidth}px`);
    this.style.setProperty("--height", `${newHeight}px`);
  }

  protected render() {
    return html`
      <div style="width: ${this.width}px; height: ${this.height}px;">
        <header @mousedown=${this.startDrag}>
          <span>Debug Window</span>
          <div class="actions">
            <button @click=${this.toggleMinimize}>
              ${this.minimized ? "🔼" : "🔽"}
            </button>
          </div>
        </header>
        <div class="content ${this.minimized ? "minimized" : ""}">
          <slot></slot>
        </div>
      </div>
    `;
  }
}
