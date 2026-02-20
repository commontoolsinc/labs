import { css, html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import {
  createDragPreview,
  endDrag,
  startDrag,
  updateDragPointer,
} from "../../core/drag-state.ts";
import type { CellHandle } from "@commontools/runtime-client";
import "../ct-cell-context/ct-cell-context.ts";

/**
 * CTDragSource - Wraps draggable content and initiates drag operations
 *
 * This component makes any content draggable and manages the drag lifecycle.
 * It automatically wraps content with ct-cell-context for debugging support.
 *
 * @element ct-drag-source
 *
 * @property {CellHandle} cell - Required: the cell being dragged
 * @property {string} type - Optional: type identifier for filtering drop zones
 * @property {boolean} disabled - Disable dragging
 *
 * @fires ct-drag-start - Fired when drag starts with { cell: CellHandle }
 * @fires ct-drag-end - Fired when drag ends with { cell: CellHandle, dropped: boolean }
 *
 * @slot - Default slot for draggable content
 *
 * @example
 * <ct-drag-source .cell=${myCellHandle} type="item">
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
  cell?: CellHandle;

  @property({ type: String })
  type?: string;

  @property({ type: Boolean, reflect: true })
  disabled?: boolean;

  @state()
  private _resolvedCell?: CellHandle;

  private _isDragging = false;
  private _isTracking = false;
  private _startX = 0;
  private _startY = 0;
  private _pointerId?: number;
  private _preview?: HTMLElement;
  private _boundPointerMove = this._handlePointerMove.bind(this);
  private _boundPointerUp = this._handlePointerUp.bind(this);

  protected override willUpdate(changedProperties: PropertyValues) {
    super.willUpdate(changedProperties);
    if (changedProperties.has("cell")) {
      this._resolveCell();
    }
  }

  private async _resolveCell() {
    // Clear immediately so stale values can't be used during async resolution
    this._resolvedCell = undefined;
    if (this.cell) {
      this._resolvedCell = await this.cell.resolveAsCell();
    }
  }

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

    // Don't preventDefault or setPointerCapture here - wait until we confirm
    // it's a drag. This allows clicks to work on non-interactive content.

    // Store initial position
    this._startX = e.clientX;
    this._startY = e.clientY;
    this._pointerId = e.pointerId;
    this._isTracking = true;

    // Add document-level listeners for move and up
    document.addEventListener("pointermove", this._boundPointerMove);
    document.addEventListener("pointerup", this._boundPointerUp);
    document.addEventListener("pointercancel", this._boundPointerUp);
  }

  private _handlePointerMove(e: PointerEvent) {
    // Ignore events from other pointers (multi-touch, secondary mouse buttons)
    if (!this.cell || !this._isTracking || e.pointerId !== this._pointerId) {
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

  private _handlePointerUp(e: PointerEvent) {
    // Ignore events from other pointers (multi-touch releases shouldn't cancel drag)
    if (e.pointerId !== this._pointerId) {
      return;
    }

    // Clean up listeners
    document.removeEventListener("pointermove", this._boundPointerMove);
    document.removeEventListener("pointerup", this._boundPointerUp);
    document.removeEventListener("pointercancel", this._boundPointerUp);

    if (this._isDragging) {
      // Drop detection is now handled by drop-zones polling the drag state
      this._endDrag();
    }

    this._isDragging = false;
    this._isTracking = false;
    this._pointerId = undefined;
  }

  private _isInteractiveElement(element: HTMLElement): boolean {
    // Check if element or any ancestor (up to this component) is interactive.
    // This ensures clicks on descendants of buttons/links work correctly.
    const interactiveSelector =
      "input, button, select, textarea, a, [role='button']";
    const interactive = element.closest(interactiveSelector);
    return interactive !== null && this.contains(interactive);
  }

  private _startDrag(e: PointerEvent) {
    const cell = this._resolvedCell ?? this.cell;
    if (!cell) {
      return;
    }

    // Now that we're actually dragging, capture the pointer and add dragging class
    const cellContext = this.shadowRoot?.querySelector(
      "ct-cell-context",
    ) as HTMLElement;
    if (cellContext) {
      if (this._pointerId !== undefined) {
        cellContext.setPointerCapture(this._pointerId);
      }
      cellContext.classList.add("dragging");
    }

    // Create preview element
    this._preview = createDragPreview(cell);
    document.body.appendChild(this._preview);

    // Position preview near cursor
    this._preview.style.left = `${e.clientX + 10}px`;
    this._preview.style.top = `${e.clientY + 10}px`;

    // Start drag in drag state
    startDrag({
      cell,
      type: this.type,
      sourceElement: this,
      preview: this._preview,
      pointerX: e.clientX,
      pointerY: e.clientY,
    });

    // Emit drag start event
    this.emit("ct-drag-start", { cell });
  }

  private _endDrag() {
    const cell = this._resolvedCell ?? this.cell;
    if (!cell) {
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
    this.emit("ct-drag-end", { cell });

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
