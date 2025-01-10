import { LitElement, html, css } from "lit-element";
import { customElement, state } from "lit/decorators.js";

interface LayoutItem {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  element: Element;
}

@customElement("common-canvas-layout")
export default class CanvasLayoutElement extends LitElement {
  @state()
  private items: Map<string, LayoutItem> = new Map();

  private dragItem: LayoutItem | null = null;
  private resizeItem: LayoutItem | null = null;
  private dragOffset = { x: 0, y: 0 };
  private resizeStart = { width: 0, height: 0 };
  private observer: MutationObserver;

  constructor() {
    super();
    this.observer = new MutationObserver(() => this.syncItems());
  }

  override connectedCallback() {
    super.connectedCallback();
    this.observer.observe(this, { childList: true, subtree: true });
    this.setupCanvas();
    this.syncItems();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.observer.disconnect();
    window.removeEventListener("mousemove", this.handleMouseMove);
    window.removeEventListener("mouseup", this.handleMouseUp);
  }

  static override styles = css`
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: 800px;
      border: 1px solid #ddd;
      background: #f9f9f9;
      overflow: auto;
    }
    /* Remove pointer-events: none from host and handle click areas explicitly */
    .canvas-area {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      pointer-events: none; /* Make the canvas area pass through clicks */
    }

    .item {
      position: absolute;
      background: rgba(255, 255, 255, 0.9);
      border: 1px solid #ccc;
      cursor: move;
      user-select: none;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      pointer-events: auto; /* Explicitly enable pointer events for items */
    }

    .resize-handle {
      position: absolute;
      right: -5px;
      bottom: -5px;
      width: 10px;
      height: 10px;
      background: #fff;
      border: 1px solid #ccc;
      cursor: se-resize;
      z-index: 1;
      pointer-events: auto; /* Explicitly enable pointer events for resize handle */
    }
  `;

  private setupCanvas() {
    this.addEventListener("mousedown", this.handleMouseDown);
    window.addEventListener("mousemove", this.handleMouseMove);
    window.addEventListener("mouseup", this.handleMouseUp);
  }

  private syncItems() {
    const slottedElements = Array.from(this.children);
    const gridSize = 120;
    const padding = 10;

    // Remove items that no longer exist
    const currentIds = new Set(slottedElements.map(el => el.id));
    for (const [id] of this.items) {
      if (!currentIds.has(id)) {
        this.items.delete(id);
      }
    }

    // Add or update items with grid-based positioning
    slottedElements.forEach((el, index) => {
      if (!el.id) {
        el.id = crypto.randomUUID();
      }

      el.setAttribute("slot", el.id);

      if (!this.items.has(el.id)) {
        const row = Math.floor(index / 3);
        const col = index % 3;

        this.items.set(el.id, {
          id: el.id,
          x: col * (gridSize + padding),
          y: row * (gridSize + padding),
          width: gridSize,
          height: gridSize,
          element: el,
        });
      }
    });

    this.requestUpdate();
  }

  private handleMouseDown = (e: MouseEvent) => {
    if (!this.shadowRoot) return;

    // Get host element's position and scroll position
    const rect = this.getBoundingClientRect();
    const scrollLeft = this.scrollLeft;
    const scrollTop = this.scrollTop;

    // Use composedPath to find the first element in our shadow root
    const path = e.composedPath();
    const element = path.find(
      el => el instanceof HTMLElement && el.getRootNode() === this.shadowRoot,
    ) as HTMLElement | undefined;

    if (!element) return;

    const itemElement = element.closest("[data-item-id]") as HTMLElement;
    if (!itemElement) return;

    const itemId = itemElement.getAttribute("data-item-id");
    if (!itemId) return;

    const item = this.items.get(itemId);
    if (!item) return;

    if (element.classList.contains("resize-handle")) {
      this.resizeItem = item;
      this.resizeStart = {
        width: item.width,
        height: item.height,
      };
    } else {
      this.dragItem = item;
      this.dragOffset = {
        x: e.clientX - item.x - rect.left + scrollLeft,
        y: e.clientY - item.y - rect.top + scrollTop,
      };
    }

    e.preventDefault();
  };

  private handleMouseMove = (e: MouseEvent) => {
    if (this.dragItem) {
      const rect = this.getBoundingClientRect();
      const newX = Math.max(
        0,
        Math.min(
          e.clientX - this.dragOffset.x - rect.left,
          rect.width - this.dragItem.width,
        ),
      );
      const newY = Math.max(
        0,
        Math.min(
          e.clientY - this.dragOffset.y - rect.top,
          rect.height - this.dragItem.height,
        ),
      );

      this.dragItem.x = newX;
      this.dragItem.y = newY;

      this.dispatchEvent(
        new CustomEvent("item-moved", {
          detail: {
            id: this.dragItem.id,
            x: newX,
            y: newY,
          },
        }),
      );

      this.requestUpdate();
    }

    if (this.resizeItem) {
      const rect = this.getBoundingClientRect();
      const deltaX =
        e.clientX - rect.left - (this.resizeItem.x + this.resizeStart.width);
      const deltaY =
        e.clientY - rect.top - (this.resizeItem.y + this.resizeStart.height);

      const newWidth = Math.max(
        50,
        Math.min(
          this.resizeStart.width + deltaX,
          rect.width - this.resizeItem.x,
        ),
      );
      const newHeight = Math.max(
        50,
        Math.min(
          this.resizeStart.height + deltaY,
          rect.height - this.resizeItem.y,
        ),
      );

      this.resizeItem.width = newWidth;
      this.resizeItem.height = newHeight;

      this.dispatchEvent(
        new CustomEvent("item-resized", {
          detail: {
            id: this.resizeItem.id,
            width: newWidth,
            height: newHeight,
          },
        }),
      );

      this.requestUpdate();
    }
  };

  private handleMouseUp = () => {
    this.dragItem = null;
    this.resizeItem = null;
  };

  override render() {
    return html`
      <div class="canvas-area">
        ${Array.from(this.items.values()).map(
          item => html`
            <div
              class="item"
              data-item-id="${item.id}"
              style="left: ${item.x}px; top: ${item.y}px; width: ${item.width}px; height: ${item.height}px;"
            >
              <slot name="${item.id}"></slot>
              <div class="resize-handle"></div>
            </div>
          `,
        )}
      </div>
    `;
  }
}
