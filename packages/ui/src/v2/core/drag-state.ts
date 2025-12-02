import type { Cell } from "@commontools/runner";

/**
 * State information for an active drag operation.
 */
export interface DragState {
  /** The Cell being dragged */
  cell: Cell;
  /** Optional type identifier for filtering drop zones */
  type?: string;
  /** The source element that initiated the drag */
  sourceElement: HTMLElement;
  /** The preview element being shown during drag */
  preview: HTMLElement;
  /** Optional cleanup function to call when drag ends */
  previewCleanup?: () => void;
}

/**
 * Callback function invoked when drag state changes.
 * Receives the new drag state, or null when drag ends.
 */
export type DragListener = (state: DragState | null) => void;

// Module-level singleton state
let currentDrag: DragState | null = null;
let listeners: Set<DragListener> = new Set();

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
 * Cleans up the preview element and notifies all subscribers.
 */
export function endDrag(): void {
  if (!currentDrag) {
    return;
  }

  // Call cleanup function if provided
  if (currentDrag.previewCleanup) {
    currentDrag.previewCleanup();
  }

  // Remove preview element from DOM
  if (currentDrag.preview.parentNode) {
    currentDrag.preview.parentNode.removeChild(currentDrag.preview);
  }

  // Clear state
  currentDrag = null;

  // Notify all subscribers that drag has ended
  notifyListeners(null);
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
