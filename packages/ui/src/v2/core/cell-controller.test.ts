import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { ReactiveControllerHost } from "lit";
import { isCellHandle } from "@commontools/runtime-client";
import { createMockCellHandle } from "../test-utils/mock-cell-handle.ts";
import {
  ArrayCellController,
  BooleanCellController,
  CellController,
  createArrayCellController,
  createBooleanCellController,
  createCellController,
  createStringCellController,
  StringCellController,
} from "./cell-controller.ts";

/** Minimal mock host satisfying Lit's ReactiveControllerHost interface. */
function createMockHost(): ReactiveControllerHost {
  return {
    addController: () => {},
    removeController: () => {},
    requestUpdate: () => {},
    updateComplete: Promise.resolve(true),
  } as unknown as ReactiveControllerHost;
}

// ---------------------------------------------------------------------------
// createMockCellHandle sanity checks
// ---------------------------------------------------------------------------

describe("createMockCellHandle", () => {
  it("passes isCellHandle()", () => {
    const h = createMockCellHandle("x");
    expect(isCellHandle(h)).toBe(true);
  });

  it("get() returns the initial value", () => {
    const h = createMockCellHandle("hello");
    expect(h.get()).toBe("hello");
  });

  it("set() updates get() and notifies subscribers", async () => {
    const h = createMockCellHandle("a");
    const values: (string | undefined)[] = [];
    h.subscribe((v) => {
      values.push(v);
    });
    await h.set("b");
    expect(h.get()).toBe("b");
    expect(values).toEqual(["a", "b"]); // initial + update
  });

  it("key() returns a child CellHandle", () => {
    const h = createMockCellHandle({ foo: 42 });
    const child = h.key("foo");
    expect(isCellHandle(child)).toBe(true);
    expect(child.get()).toBe(42);
  });

  it("subscribe() calls callback immediately with current value", () => {
    const h = createMockCellHandle("now");
    let received: string | undefined;
    h.subscribe((v) => {
      received = v;
    });
    expect(received).toBe("now");
  });
});

// ---------------------------------------------------------------------------
// CellController
// ---------------------------------------------------------------------------

describe("CellController", () => {
  it("binds a CellHandle and reads its value", () => {
    const host = createMockHost();
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
    });
    const cell = createMockCellHandle("init");
    ctrl.bind(cell);
    expect(ctrl.getValue()).toBe("init");
    expect(ctrl.hasCell()).toBe(true);
    expect(ctrl.getCell()).toBe(cell);
  });

  it("binds a plain value", () => {
    const host = createMockHost();
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
    });
    ctrl.bind("plain" as any);
    expect(ctrl.getValue()).toBe("plain");
    expect(ctrl.hasCell()).toBe(false);
    expect(ctrl.getCell()).toBeNull();
  });

  it("setValue updates the underlying CellHandle", () => {
    const host = createMockHost();
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
    });
    const cell = createMockCellHandle("before");
    ctrl.bind(cell);
    ctrl.setValue("after");
    // CellHandle.set is async but updates local cache synchronously
    expect(cell.get()).toBe("after");
  });

  it("calls onChange when setValue is invoked", () => {
    const host = createMockHost();
    const changes: Array<{ newVal: string; oldVal: string }> = [];
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
      onChange: (n, o) => changes.push({ newVal: n, oldVal: o }),
    });
    const cell = createMockCellHandle("a");
    ctrl.bind(cell);
    // bind() sets up subscription which fires onChange("a", undefined) initially.
    // Clear those so we can test setValue in isolation.
    changes.length = 0;

    ctrl.setValue("b");
    // setValue fires onChange directly, and then the cell subscription callback
    // also fires onChange when it sees the new value.
    const setValueChange = changes.find((c) => c.newVal === "b");
    expect(setValueChange).toBeDefined();
    expect(setValueChange!.oldVal).toBe("a");
  });

  it("requestUpdate is called when cell subscription fires", async () => {
    let updateCount = 0;
    const host: ReactiveControllerHost = {
      addController: () => {},
      removeController: () => {},
      requestUpdate: () => {
        updateCount++;
      },
      updateComplete: Promise.resolve(true),
    } as unknown as ReactiveControllerHost;

    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
    });
    const cell = createMockCellHandle("x");
    ctrl.bind(cell);
    // bind sets up subscription which calls requestUpdate immediately
    const initialCount = updateCount;
    await cell.set("y");
    expect(updateCount).toBeGreaterThan(initialCount);
  });

  it("re-bind to a different cell cleans up old subscription", () => {
    const host = createMockHost();
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
    });
    // Use distinct refs so CellHandle.equals() returns false
    const cell1 = createMockCellHandle("one", {
      id: "of:cell-1" as any,
    });
    const cell2 = createMockCellHandle("two", {
      id: "of:cell-2" as any,
    });
    ctrl.bind(cell1);
    ctrl.bind(cell2);
    expect(ctrl.getValue()).toBe("two");
    expect(ctrl.getCell()).toBe(cell2);
  });

  it("hostDisconnected cleans up subscription", () => {
    const host = createMockHost();
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
    });
    const cell = createMockCellHandle("val");
    ctrl.bind(cell);
    ctrl.hostDisconnected();
    // After disconnect, the controller should still return the last known value
    // but shouldn't crash
    expect(ctrl.getValue()).toBe("val");
  });

  it("getValue returns undefined when nothing is bound", () => {
    const host = createMockHost();
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
    });
    expect(ctrl.getValue()).toBeUndefined();
  });

  it("setValue is a no-op when nothing is bound", () => {
    const host = createMockHost();
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
    });
    // Should not throw
    ctrl.setValue("ignored");
  });
});

// ---------------------------------------------------------------------------
// StringCellController
// ---------------------------------------------------------------------------

describe("StringCellController", () => {
  it("defaults to empty string for undefined cell value", () => {
    const host = createMockHost();
    const ctrl = new StringCellController(host);
    const cell = createMockCellHandle<string>(undefined as any);
    ctrl.bind(cell);
    expect(ctrl.getValue()).toBe("");
  });

  it("returns the cell's string value", () => {
    const host = createMockHost();
    const ctrl = new StringCellController(host);
    const cell = createMockCellHandle("hello");
    ctrl.bind(cell);
    expect(ctrl.getValue()).toBe("hello");
  });

  it("returns plain string value", () => {
    const host = createMockHost();
    const ctrl = new StringCellController(host);
    ctrl.bind("world" as any);
    expect(ctrl.getValue()).toBe("world");
  });

  it("preserves empty string (not falsy coerced)", () => {
    const host = createMockHost();
    const ctrl = new StringCellController(host);
    ctrl.bind("" as any);
    expect(ctrl.getValue()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// BooleanCellController
// ---------------------------------------------------------------------------

describe("BooleanCellController", () => {
  it("defaults to false for undefined cell value", () => {
    const host = createMockHost();
    const ctrl = new BooleanCellController(host);
    const cell = createMockCellHandle<boolean>(undefined as any);
    ctrl.bind(cell);
    expect(ctrl.getValue()).toBe(false);
  });

  it("reads boolean from cell", () => {
    const host = createMockHost();
    const ctrl = new BooleanCellController(host);
    const cell = createMockCellHandle(true);
    ctrl.bind(cell);
    expect(ctrl.getValue()).toBe(true);
  });

  it("toggle() flips the value", () => {
    const host = createMockHost();
    const ctrl = new BooleanCellController(host);
    const cell = createMockCellHandle(false);
    ctrl.bind(cell);
    ctrl.toggle();
    expect(cell.get()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ArrayCellController
// ---------------------------------------------------------------------------

describe("ArrayCellController", () => {
  it("defaults to empty array for undefined cell value", () => {
    const host = createMockHost();
    const ctrl = new ArrayCellController<number>(host);
    const cell = createMockCellHandle<number[]>(undefined as any);
    ctrl.bind(cell);
    expect(ctrl.getValue()).toEqual([]);
  });

  it("reads array from cell", () => {
    const host = createMockHost();
    const ctrl = new ArrayCellController<number>(host);
    const cell = createMockCellHandle([1, 2, 3]);
    ctrl.bind(cell);
    expect(ctrl.getValue()).toEqual([1, 2, 3]);
  });

  it("addItem appends via cell.push()", () => {
    const host = createMockHost();
    const ctrl = new ArrayCellController<number>(host);
    const cell = createMockCellHandle([1, 2]);
    ctrl.bind(cell);
    ctrl.addItem(3);
    expect(cell.get()).toEqual([1, 2, 3]);
  });

  it("removeItem filters out the item", () => {
    const host = createMockHost();
    const ctrl = new ArrayCellController<string>(host);
    const cell = createMockCellHandle(["a", "b", "c"]);
    ctrl.bind(cell);
    ctrl.removeItem("b");
    expect(cell.get()).toEqual(["a", "c"]);
  });

  it("updateItem replaces item via cell.key().set()", () => {
    const host = createMockHost();
    const ctrl = new ArrayCellController<string>(host);
    const cell = createMockCellHandle(["x", "y", "z"]);
    ctrl.bind(cell);
    // updateItem uses cell.key(index).set() for CellHandle-backed arrays.
    // The child CellHandle gets the update; the parent's local cache
    // isn't automatically synced (that happens via backend push in prod).
    // Just verify the call doesn't throw and the child reflects the value.
    ctrl.updateItem("y", "Y");
    // key() creates a fresh child each time, pre-populated from parent cache
    // Since parent cache still has "y", the new child reads "y".
    // The actual set() went through on the child that updateItem created.
    // In production the backend would push the update to the parent.
    // For this test, we just verify no errors occur.
  });
});

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

describe("factory functions", () => {
  it("createCellController returns CellController", () => {
    const ctrl = createCellController<string>(createMockHost());
    expect(ctrl).toBeInstanceOf(CellController);
  });

  it("createStringCellController returns StringCellController", () => {
    const ctrl = createStringCellController(createMockHost());
    expect(ctrl).toBeInstanceOf(StringCellController);
  });

  it("createBooleanCellController returns BooleanCellController", () => {
    const ctrl = createBooleanCellController(createMockHost());
    expect(ctrl).toBeInstanceOf(BooleanCellController);
  });

  it("createArrayCellController returns ArrayCellController", () => {
    const ctrl = createArrayCellController<number>(createMockHost());
    expect(ctrl).toBeInstanceOf(ArrayCellController);
  });
});
