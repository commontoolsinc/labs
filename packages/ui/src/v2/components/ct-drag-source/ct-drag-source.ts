import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import {
  endDrag,
  startDrag,
  updateDragPointer,
} from "../../core/drag-state.ts";
import { render } from "@commontools/html";
import { UI } from "@commontools/runner";
import type { Cell } from "@commontools/runner";
import "../ct-cell-context/ct-cell-context.ts";
import "../ct-cell-link/ct-cell-link.ts";

/**
 * CTDragSource - Wraps draggable content and initiates drag operations
 *
 * This component makes any content draggable and manages the drag lifecycle.
 * It automatically wraps content with ct-cell-context for debugging support.
 *
 * @element ct-drag-source
 *
 * @property {Cell} cell - Required: the cell being dragged
 * @property {string} type - Optional: type identifier for filtering drop zones
 * @property {boolean} disabled - Disable dragging
 *
 * @fires ct-drag-start - Fired when drag starts with { cell: Cell }
 * @fires ct-drag-end - Fired when drag ends with { cell: Cell, dropped: boolean }
 *
 * @slot - Default slot for draggable content
 *
 * @example
 * <ct-drag-source .cell=${myCell} type="item">
 *   <div>Drag me!</div>
 * </ct-drag-source>
 */
export class CTDragSource extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
      }

      :host([disabled]) {
        opacity: 0.5;
        cursor: not-allowed;
      }

      :host(:not([disabled])) ct-cell-context {
        cursor: grab;
      }

      :host(:not([disabled])) ct-cell-context.dragging {
        cursor: grabbing;
        opacity: 0.5;
      }
    `,
  ];

  @property({ attribute: false })
  cell?: Cell;

  @property({ type: String })
  type?: string;

  @property({ type: Boolean, reflect: true })
  disabled?: boolean;

  private _isDragging = false;
  private _isTracking = false;
  private _startX = 0;
  private _startY = 0;
  private _pointerId?: number;
  private _preview?: HTMLElement;
  private _boundPointerMove = this._handlePointerMove.bind(this);
  private _boundPointerUp = this._handlePointerUp.bind(this);

  private _handlePointerDown(e: PointerEvent) {
    // Skip if disabled
    if (this.disabled || !this.cell) {
      return;
    }

    // Skip if Alt is held - user is interacting with ct-cell-context debug UI
    if (e.altKey) {
      return;
    }

    // Skip if clicking on interactive elements
    const target = e.target as HTMLElement;
    if (this._isInteractiveElement(target)) {
      return;
    }

    // Prevent default and capture pointer for drag
    e.preventDefault();

    // Store initial position
    this._startX = e.clientX;
    this._startY = e.clientY;
    this._pointerId = e.pointerId;
    this._isTracking = true;

    // Capture pointer events
    const cellContext = this.shadowRoot?.querySelector(
      "ct-cell-context",
    ) as HTMLElement;
    if (cellContext) {
      cellContext.setPointerCapture(e.pointerId);
    }

    // Add document-level listeners for move and up
    document.addEventListener("pointermove", this._boundPointerMove);
    document.addEventListener("pointerup", this._boundPointerUp);
  }

  private _handlePointerMove(e: PointerEvent) {
    if (!this.cell || !this._isTracking) {
      return;
    }

    const deltaX = e.clientX - this._startX;
    const deltaY = e.clientY - this._startY;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    // Start drag after threshold (~5px)
    if (!this._isDragging && distance > 5) {
      this._isDragging = true;
      this._startDrag(e);
    }

    // Update preview position and notify drop zones if dragging
    if (this._isDragging && this._preview) {
      this._preview.style.left = `${e.clientX + 10}px`;
      this._preview.style.top = `${e.clientY + 10}px`;
      // Update drag state so drop zones can check intersection
      updateDragPointer(e.clientX, e.clientY);
    }
  }

  private _handlePointerUp(_e: PointerEvent) {
    // Clean up listeners
    document.removeEventListener("pointermove", this._boundPointerMove);
    document.removeEventListener("pointerup", this._boundPointerUp);

    if (this._isDragging) {
      // Drop detection is now handled by drop-zones polling the drag state
      this._endDrag();
    }

    this._isDragging = false;
    this._isTracking = false;
    this._pointerId = undefined;
  }

  private _isInteractiveElement(element: HTMLElement): boolean {
    const tagName = element.tagName.toLowerCase();
    const interactiveTags = ["input", "button", "select", "textarea", "a"];
    return interactiveTags.includes(tagName);
  }

  private _startDrag(e: PointerEvent) {
    if (!this.cell) {
      return;
    }

    // Create preview element
    this._preview = this._createPreview();
    document.body.appendChild(this._preview);

    // Position preview near cursor
    this._preview.style.left = `${e.clientX + 10}px`;
    this._preview.style.top = `${e.clientY + 10}px`;

    // Add dragging class to source
    const cellContext = this.shadowRoot?.querySelector("ct-cell-context");
    if (cellContext) {
      cellContext.classList.add("dragging");
    }

    // Start drag in drag state
    startDrag({
      cell: this.cell,
      type: this.type,
      sourceElement: this,
      preview: this._preview,
      pointerX: e.clientX,
      pointerY: e.clientY,
    });

    // Emit drag start event
    this.emit("ct-drag-start", { cell: this.cell });
  }

  private _createPreview(): HTMLElement {
    if (!this.cell) {
      throw new Error("Cannot create preview without cell");
    }

    const preview = document.createElement("div");
    // Apply inline styles since this element is appended to document.body
    // (outside our shadow DOM where .preview class would apply)
    preview.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 10000;
      opacity: 0.9;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      background: white;
      border: 1px solid #ccc;
      padding: 0.5rem;
      border-radius: 4px;
      max-width: 300px;
      max-height: 200px;
      overflow: hidden;
    `;

    // Check if cell value has [UI] property
    const cellValue = this.cell.get();
    if (cellValue && typeof cellValue === "object" && UI in cellValue) {
      // Render using [UI]
      try {
        const uiValue = (cellValue as Record<string, unknown>)[UI];
        render(preview, uiValue as any);
      } catch (error) {
        console.warn("[ct-drag-source] Failed to render [UI]:", error);
        this._createFallbackPreview(preview);
      }
    } else {
      // Use ct-cell-link as fallback
      this._createFallbackPreview(preview);
    }

    return preview;
  }

  private _createFallbackPreview(container: HTMLElement) {
    if (!this.cell) {
      return;
    }

    const link = document.createElement("ct-cell-link");
    link.cell = this.cell;
    container.appendChild(link);
  }

  private _endDrag() {
    if (!this.cell) {
      return;
    }

    // Remove dragging class
    const cellContext = this.shadowRoot?.querySelector("ct-cell-context");
    if (cellContext) {
      cellContext.classList.remove("dragging");
    }

    // End drag in drag state (this will clean up preview)
    // Drop zones handle their own detection and emit ct-drop events
    endDrag();

    // Emit drag end event
    this.emit("ct-drag-end", { cell: this.cell });

    this._preview = undefined;
  }

  override render() {
    return html`
      <ct-cell-context
        .cell="${this.cell}"
        @pointerdown="${this._handlePointerDown}"
      >
        <slot></slot>
      </ct-cell-context>
    `;
  }
}

globalThis.customElements.define("ct-drag-source", CTDragSource);

declare global {
  interface HTMLElementTagNameMap {
    "ct-drag-source": CTDragSource;
  }
}
