import { css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";

@customElement("ct-draggable")
export class CtDraggable extends BaseElement {
  @property({ type: Number })
  x = 0;

  @property({ type: Number })
  y = 0;

  @state()
  private isDragging = false;

  private dragStartX = 0;
  private dragStartY = 0;
  private initialMouseX = 0;
  private initialMouseY = 0;

  static override styles = css`
    :host {
      position: absolute;
      padding: 10px;
      background-color: #ffffcc;
      border: 1px solid #ddd;
      border-radius: 4px;
      max-width: 200px;
      cursor: move;
      user-select: none;
    }

    :host(.dragging) {
      opacity: 0.8;
      z-index: 1000;
      cursor: grabbing;
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    console.log(`[Draggable] Connected: x=${this.x}, y=${this.y}`);
    // Set initial position from props
    this.style.left = `${this.x}px`;
    this.style.top = `${this.y}px`;

    // Add document-level listeners for mouse move and up
    document.addEventListener("mousemove", this.handleMouseMove);
    document.addEventListener("mouseup", this.handleMouseUp);
  }

  override disconnectedCallback() {
    console.log(`[Draggable] Disconnected: x=${this.x}, y=${this.y}`);
    super.disconnectedCallback();
    document.removeEventListener("mousemove", this.handleMouseMove);
    document.removeEventListener("mouseup", this.handleMouseUp);
  }

  private handleMouseDown = (event: MouseEvent) => {
    // Don't start drag if clicking on an input or button
    const target = event.target as HTMLElement;
    if (
      target.tagName === "INPUT" || target.tagName === "BUTTON" ||
      target.closest("common-send-message")
    ) {
      return;
    }

    console.log(
      `[Draggable] Mouse down - starting drag from x=${this.x}, y=${this.y}`,
    );
    event.preventDefault();
    this.isDragging = true;
    this.dragStartX = this.x;
    this.dragStartY = this.y;
    this.initialMouseX = event.clientX;
    this.initialMouseY = event.clientY;
    this.classList.add("dragging");
  };

  private handleMouseMove = (event: MouseEvent) => {
    if (!this.isDragging) return;

    const deltaX = event.clientX - this.initialMouseX;
    const deltaY = event.clientY - this.initialMouseY;
    const newX = this.dragStartX + deltaX;
    const newY = this.dragStartY + deltaY;

    // Update position immediately for smooth dragging
    this.style.left = `${newX}px`;
    this.style.top = `${newY}px`;
  };

  private handleMouseUp = (event: MouseEvent) => {
    if (!this.isDragging) return;

    // Stop the event from bubbling up to the canvas
    event.stopPropagation();

    this.isDragging = false;
    this.classList.remove("dragging");

    const deltaX = event.clientX - this.initialMouseX;
    const deltaY = event.clientY - this.initialMouseY;
    const newX = this.dragStartX + deltaX;
    const newY = this.dragStartY + deltaY;

    console.log(
      `[Draggable] Before emit - current props: x=${this.x}, y=${this.y}, new position: x=${newX}, y=${newY}`,
    );

    // Emit position change event with new coordinates
    this.emit("positionchange", { x: newX, y: newY });

    console.log(`[Draggable] After emit - props should update soon`);
  };

  override updated(changedProperties: Map<string, any>) {
    // Update position from props only when not dragging
    if (
      !this.isDragging &&
      (changedProperties.has("x") || changedProperties.has("y"))
    ) {
      console.log(
        `[Draggable] Props updated: x=${this.x}, y=${this.y} - updating styles`,
      );
      this.style.left = `${this.x}px`;
      this.style.top = `${this.y}px`;
    }
  }

  override render() {
    return html`
      <div @mousedown="${this.handleMouseDown}">
        <slot></slot>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ct-draggable": CtDraggable;
  }
}
