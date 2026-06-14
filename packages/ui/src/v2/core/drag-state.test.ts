import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type CellHandle } from "@commonfabric/runtime-client";
import { createMockCellHandle } from "../test-utils/mock-cell-handle.ts";
import {
  type DragState,
  endDrag,
  getCurrentDrag,
  isDragging,
  startDrag,
  subscribeToDrag,
  subscribeToEndDrag,
  updateDragPointer,
} from "./drag-state.ts";

/** Create a minimal DragState for testing (no real DOM elements). */
function createMockDragState(overrides?: Partial<DragState>): DragState {
  return {
    cell: createMockCellHandle({ name: "test" }) as CellHandle,
    sourceElement: {} as HTMLElement,
    preview: { parentNode: null } as unknown as HTMLElement,
    pointerX: 0,
    pointerY: 0,
    ...overrides,
  };
}

/** Reset module-level singleton state between tests. */
function cleanup() {
  // End any active drag to reset state
  if (isDragging()) {
    endDrag();
  }
}

// ---------------------------------------------------------------------------
// Core state management
// ---------------------------------------------------------------------------

describe("drag-state — core", () => {
  afterEach(cleanup);

  it("isDragging() is false initially", () => {
    expect(isDragging()).toBe(false);
    expect(getCurrentDrag()).toBeNull();
  });

  it("startDrag sets active drag state", () => {
    const state = createMockDragState();
    startDrag(state);
    expect(isDragging()).toBe(true);
    expect(getCurrentDrag()).toBe(state);
  });

  it("endDrag clears drag state", () => {
    startDrag(createMockDragState());
    endDrag();
    expect(isDragging()).toBe(false);
    expect(getCurrentDrag()).toBeNull();
  });

  it("endDrag is a no-op when not dragging", () => {
    endDrag(); // should not throw
    expect(isDragging()).toBe(false);
  });

  it("endDrag calls previewCleanup if provided", () => {
    let cleaned = false;
    startDrag(createMockDragState({
      previewCleanup: () => {
        cleaned = true;
      },
    }));
    endDrag();
    expect(cleaned).toBe(true);
  });

  it("endDrag removes preview from parent if attached", () => {
    let childRemoved = false;
    const mockParent = {
      removeChild: () => {
        childRemoved = true;
      },
    };
    startDrag(createMockDragState({
      preview: { parentNode: mockParent } as unknown as HTMLElement,
    }));
    endDrag();
    expect(childRemoved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pointer updates
// ---------------------------------------------------------------------------

describe("drag-state — pointer updates", () => {
  afterEach(cleanup);

  it("updateDragPointer updates position on active drag", () => {
    startDrag(createMockDragState());
    updateDragPointer(100, 200);

    const state = getCurrentDrag()!;
    expect(state.pointerX).toBe(100);
    expect(state.pointerY).toBe(200);
  });

  it("updateDragPointer is a no-op when not dragging", () => {
    updateDragPointer(50, 50); // should not throw
  });
});

// ---------------------------------------------------------------------------
// Subscribers
// ---------------------------------------------------------------------------

describe("drag-state — subscribeToDrag", () => {
  afterEach(cleanup);

  it("calls listener immediately with current state", () => {
    const received: (DragState | null)[] = [];
    subscribeToDrag((s) => received.push(s));
    expect(received).toEqual([null]); // no active drag
  });

  it("calls listener immediately with active drag state", () => {
    const state = createMockDragState();
    startDrag(state);

    const received: (DragState | null)[] = [];
    subscribeToDrag((s) => received.push(s));
    expect(received[0]).toBe(state);
  });

  it("notifies on startDrag", () => {
    const received: (DragState | null)[] = [];
    subscribeToDrag((s) => received.push(s));
    received.length = 0; // clear initial

    const state = createMockDragState();
    startDrag(state);
    expect(received.length).toBe(1);
    expect(received[0]).toBe(state);
  });

  it("notifies with null on endDrag", () => {
    startDrag(createMockDragState());
    const received: (DragState | null)[] = [];
    subscribeToDrag((s) => received.push(s));
    received.length = 0;

    endDrag();
    const lastNotification = received[received.length - 1];
    expect(lastNotification).toBeNull();
  });

  it("notifies on updateDragPointer", () => {
    startDrag(createMockDragState());
    const received: (DragState | null)[] = [];
    subscribeToDrag((s) => received.push(s));
    received.length = 0;

    updateDragPointer(42, 84);
    expect(received.length).toBe(1);
    expect(received[0]!.pointerX).toBe(42);
    expect(received[0]!.pointerY).toBe(84);
  });

  it("unsubscribe stops notifications", () => {
    const received: (DragState | null)[] = [];
    const unsub = subscribeToDrag((s) => received.push(s));
    received.length = 0;

    unsub();
    startDrag(createMockDragState());
    expect(received).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// End drag subscribers
// ---------------------------------------------------------------------------

describe("drag-state — subscribeToEndDrag", () => {
  afterEach(cleanup);

  it("fires with final state before cleanup", () => {
    const state = createMockDragState();
    startDrag(state);

    const endStates: DragState[] = [];
    subscribeToEndDrag((s) => endStates.push(s));

    endDrag();
    expect(endStates.length).toBe(1);
    expect(endStates[0]).toBe(state);
  });

  it("does not fire when endDrag is called with no active drag", () => {
    const endStates: DragState[] = [];
    subscribeToEndDrag((s) => endStates.push(s));

    endDrag();
    expect(endStates).toEqual([]);
  });

  it("unsubscribe stops end notifications", () => {
    const endStates: DragState[] = [];
    const unsub = subscribeToEndDrag((s) => endStates.push(s));
    unsub();

    startDrag(createMockDragState());
    endDrag();
    expect(endStates).toEqual([]);
  });
});
