import { type CellHandle, UI } from "@commontools/runtime-client";
import { render } from "@commontools/html/client";
import "../components/ct-cell-link/ct-cell-link.ts";

/**
 * State information for an active drag operation.
 */
export interface DragState {
  /** The CellHandle being dragged */
  cell: CellHandle;
  /** Optional type identifier for filtering drop zones */
  type?: string;
  /** The source element that initiated the drag */
  sourceElement: HTMLElement;
  /** The preview element being shown during drag */
  preview: HTMLElement;
  /** Optional cleanup function to call when drag ends */
  previewCleanup?: () => void;
  /** Current pointer X position (updated during drag) */
  pointerX: number;
  /** Current pointer Y position (updated during drag) */
  pointerY: number;
}

/**
 * Callback function invoked when drag state changes.
 * Receives the new drag state, or null when drag ends.
 */
export type DragListener = (state: DragState | null) => void;

// Module-level singleton state
let currentDrag: DragState | null = null;
const listeners: Set<DragListener> = new Set();

/**
 * Begin a drag operation with the given state.
 * Notifies all subscribers of the new drag state.
 *
 * @param state - The drag state to set
 */
export function startDrag(state: DragState): void {
  currentDrag = state;
  notifyListeners(state);
}

/**
 * End the current drag operation.
 * First notifies listeners with the final state (so drop zones can emit drop events),
 * then cleans up the preview element and notifies with null.
 */
export function endDrag(): void {
  if (!currentDrag) {
    return;
  }

  // Store reference before clearing
  const finalState = currentDrag;

  // Notify listeners that drag is ending (with isEnding flag)
  // Drop zones use this to emit ct-drop if pointer is over them
  notifyListenersOfEnd(finalState);

  // Call cleanup function if provided
  if (finalState.previewCleanup) {
    finalState.previewCleanup();
  }

  // Remove preview element from DOM
  if (finalState.preview.parentNode) {
    finalState.preview.parentNode.removeChild(finalState.preview);
  }

  // Clear state
  currentDrag = null;

  // Notify all subscribers that drag has ended
  notifyListeners(null);
}

/**
 * Callbacks for when drag is ending (before cleanup).
 * Used by drop zones to emit drop events.
 */
type DragEndListener = (state: DragState) => void;
const endListeners: Set<DragEndListener> = new Set();

/**
 * Subscribe to drag end events.
 * Called with the final drag state BEFORE it's cleared.
 * Use this to emit drop events if the pointer is over your drop zone.
 *
 * @param listener - Callback invoked when drag ends
 * @returns Unsubscribe function
 */
export function subscribeToEndDrag(listener: DragEndListener): () => void {
  endListeners.add(listener);
  return () => {
    endListeners.delete(listener);
  };
}

/**
 * Internal helper to notify end listeners.
 */
function notifyListenersOfEnd(state: DragState): void {
  endListeners.forEach((listener) => {
    try {
      listener(state);
    } catch (error) {
      console.error("[drag-state] Error in drag end listener:", error);
    }
  });
}

/**
 * Get the current drag state.
 *
 * @returns The current drag state, or null if no drag is active
 */
export function getCurrentDrag(): DragState | null {
  return currentDrag;
}

/**
 * Check if a drag operation is currently active.
 *
 * @returns true if a drag is active, false otherwise
 */
export function isDragging(): boolean {
  return currentDrag !== null;
}

/**
 * Update the current pointer position during drag.
 * This is called by drag-source on pointermove to keep drop zones informed.
 *
 * @param x - Current pointer X position
 * @param y - Current pointer Y position
 */
export function updateDragPointer(x: number, y: number): void {
  if (!currentDrag) {
    return;
  }

  currentDrag.pointerX = x;
  currentDrag.pointerY = y;

  // Notify listeners of position update
  notifyListeners(currentDrag);
}

/**
 * Subscribe to drag state changes.
 * The listener will be called immediately with the current state,
 * and then on every state change.
 *
 * @param listener - Callback function to invoke on state changes
 * @returns Unsubscribe function to remove the listener
 */
export function subscribeToDrag(listener: DragListener): () => void {
  listeners.add(listener);

  // Call immediately with current state
  listener(currentDrag);

  // Return unsubscribe function
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Create a drag preview element for a cell.
 * Uses the cell's [UI] property if available, otherwise falls back to
 * a static ct-cell-link pill.
 *
 * @param cell - The CellHandle to create a preview for
 * @returns The preview element (not yet added to DOM)
 */
export function createDragPreview(cell: CellHandle): HTMLElement {
  const preview = document.createElement("div");
  preview.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 10000;
    opacity: 0.9;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    background: white;
    border: 1px solid #ccc;
    border-radius: 4px;
    padding: 0.5rem;
    max-width: 300px;
    max-height: 200px;
    overflow: hidden;
  `;

  const cellValue = cell.get();
  if (cellValue && typeof cellValue === "object" && UI in cellValue) {
    try {
      render(preview, (cellValue as Record<string, unknown>)[UI] as any);
    } catch (error) {
      console.warn("[drag-state] Failed to render [UI] preview:", error);
      _addFallbackPreview(preview, cell);
    }
  } else {
    _addFallbackPreview(preview, cell);
  }

  return preview;
}

function _addFallbackPreview(container: HTMLElement, cell: CellHandle) {
  const link = document.createElement("ct-cell-link");
  link.cell = cell;
  link.isStatic = true;
  container.appendChild(link);
}

/**
 * Internal helper to notify all listeners of state change.
 */
function notifyListeners(state: DragState | null): void {
  listeners.forEach((listener) => {
    try {
      listener(state);
    } catch (error) {
      console.error("[drag-state] Error in drag listener:", error);
    }
  });
}
