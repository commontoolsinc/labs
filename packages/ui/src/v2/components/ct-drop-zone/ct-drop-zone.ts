import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import { subscribeToDrag, getCurrentDrag } from "../../core/drag-state.ts";
import type { Cell } from "@commontools/runner";
import type { DragState } from "../../core/drag-state.ts";

/**
 * CTDropZone - Marks a region as droppable and emits events when valid drops occur
 *
 * Purely behavioral component with no visual representation except CSS feedback
 * during drag-over. Listens to the global drag state and validates drops based
 * on optional type filtering.
 *
 * @element ct-drop-zone
 *
 * @property {Cell} cell - Optional context cell to pass in drop event
 * @property {string} accept - Optional filter by drag source type (comma-separated)
 *
 * @fires ct-drag-enter - When a valid drag enters the zone
 * @fires ct-drag-leave - When a drag leaves the zone
 * @fires ct-drop - When a valid drop occurs
 *
 * @slot - Default slot for wrapped content
 *
 * @example
 * <ct-drop-zone .cell=${targetCell} accept="item,folder">
 *   <div>Drop items here</div>
 * </ct-drop-zone>
 */
export class CTDropZone extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
      }

      :host([drag-over]) {
        outline: 2px dashed var(--ct-color-primary, #0066cc);
        outline-offset: -2px;
      }
    `,
  ];

  @property({ attribute: false })
  cell?: Cell;

  @property({ type: String })
  accept?: string;

  @state()
  private _isDragOver: boolean = false;

  private _unsubscribeDrag?: () => void;
  private _currentDragState: DragState | null = null;

  override connectedCallback() {
    super.connectedCallback();

    // Subscribe to global drag state changes
    this._unsubscribeDrag = subscribeToDrag((state) => {
      this._currentDragState = state;

      // If drag ended while we were in drag-over state, clean up
      if (!state && this._isDragOver) {
        this._handleDragLeave();
      }
    });

    // Add pointer event listeners for tracking enter/leave
    this.addEventListener("pointerenter", this._handlePointerEnter);
    this.addEventListener("pointerleave", this._handlePointerLeave);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();

    // Unsubscribe from drag state
    if (this._unsubscribeDrag) {
      this._unsubscribeDrag();
      this._unsubscribeDrag = undefined;
    }

    // Remove pointer event listeners
    this.removeEventListener("pointerenter", this._handlePointerEnter);
    this.removeEventListener("pointerleave", this._handlePointerLeave);
  }

  /**
   * Check if a drag type is accepted by this drop zone
   */
  private isAccepted(dragType?: string): boolean {
    if (!this.accept) return true; // Accept all if no filter
    if (!dragType) return true; // Accept untyped drags

    const types = this.accept.split(",").map((t) => t.trim());
    return types.includes(dragType);
  }

  /**
   * Handle pointer entering the drop zone
   */
  private _handlePointerEnter = () => {
    const dragState = getCurrentDrag();

    // Only show feedback if drag is active AND type matches accept filter
    if (dragState && this.isAccepted(dragState.type)) {
      this._handleDragEnter(dragState);
    }
  };

  /**
   * Handle pointer leaving the drop zone
   */
  private _handlePointerLeave = () => {
    if (this._isDragOver) {
      this._handleDragLeave();
    }
  };

  /**
   * Handle drag entering the zone
   */
  private _handleDragEnter(dragState: DragState) {
    if (this._isDragOver) return; // Already in drag-over state

    this._isDragOver = true;
    this.toggleAttribute("drag-over", true);

    this.emit("ct-drag-enter", {
      cell: this.cell,
      type: dragState.type,
    });
  }

  /**
   * Handle drag leaving the zone
   */
  private _handleDragLeave() {
    if (!this._isDragOver) return; // Not in drag-over state

    this._isDragOver = false;
    this.toggleAttribute("drag-over", false);

    this.emit("ct-drag-leave", {
      cell: this.cell,
    });
  }

  /**
   * Handle a drop event (called by ct-drag-source via elementsFromPoint)
   * This is the public API for drop handling
   */
  public handleDrop(sourceCell: Cell, type?: string): void {
    if (!this.isAccepted(type)) {
      return; // Don't emit drop event if type doesn't match
    }

    // Clean up drag-over state
    if (this._isDragOver) {
      this._isDragOver = false;
      this.toggleAttribute("drag-over", false);
    }

    // Emit drop event
    this.emit("ct-drop", {
      sourceCell,
      targetCell: this.cell,
      type,
    });
  }

  override render() {
    return html`<slot></slot>`;
  }
}

globalThis.customElements.define("ct-drop-zone", CTDropZone);

declare global {
  interface HTMLElementTagNameMap {
    "ct-drop-zone": CTDropZone;
  }
}
