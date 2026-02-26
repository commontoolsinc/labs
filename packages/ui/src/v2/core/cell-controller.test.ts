import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { ReactiveControllerHost } from "lit";
import { isCellHandle } from "@commontools/runtime-client";
import {
  createMockCellHandle,
  pushUpdate,
} from "../test-utils/mock-cell-handle.ts";
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

  it("child.set() propagates to parent value and fires parent subscribers", async () => {
    const parent = createMockCellHandle({ name: "Alice", age: 30 });
    const values: unknown[] = [];
    parent.subscribe((v) => values.push(structuredClone(v)));

    const child = parent.key("name");
    await child.set("Bob");

    expect(parent.get()).toEqual({ name: "Bob", age: 30 });
    // values[0] = initial ({name:"Alice",age:30}), values[1] = after child.set
    expect(values.length).toBeGreaterThanOrEqual(2);
    expect(values[values.length - 1]).toEqual({ name: "Bob", age: 30 });
  });

  it("child.set() on array element propagates to parent", async () => {
    const parent = createMockCellHandle(["x", "y", "z"]);
    const item = parent.key(1 as keyof string[]);
    await item.set("Y" as any);
    expect(parent.get()).toEqual(["x", "Y", "z"]);
  });

  it("pushUpdate() simulates backend-pushed value change", () => {
    const cell = createMockCellHandle("original");
    const received: (string | undefined)[] = [];
    cell.subscribe((v) => received.push(v));
    received.length = 0; // clear initial

    pushUpdate(cell, "from-backend");
    expect(cell.get()).toBe("from-backend");
    expect(received).toEqual(["from-backend"]);
  });

  it("pushUpdate() suppresses callback when value is equal", () => {
    const cell = createMockCellHandle(42);
    let callCount = 0;
    cell.subscribe(() => callCount++);
    const afterSubscribe = callCount;

    pushUpdate(cell, 42); // same value
    expect(callCount).toBe(afterSubscribe);
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

  it("bind() with schema parameter creates schema-annotated handle", () => {
    const host = createMockHost();
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
    });
    const cell = createMockCellHandle("typed");
    const schema = { type: "string" } as const;
    ctrl.bind(cell, schema);
    // bind(cell, schema) calls cell.asSchema(schema) — the controller should
    // hold a different handle than the original, with the schema on its ref.
    expect(ctrl.getValue()).toBe("typed");
    expect(ctrl.hasCell()).toBe(true);
    const bound = ctrl.getCell()!;
    expect(bound).not.toBe(cell); // asSchema creates a new handle
    expect(bound.ref().schema).toEqual(schema);
  });

  it("hostConnected() re-establishes subscription after disconnect", () => {
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
    const cell = createMockCellHandle("a");
    ctrl.bind(cell);

    ctrl.hostDisconnected();
    updateCount = 0;
    pushUpdate(cell, "while-disconnected");
    expect(updateCount).toBe(0); // no updates while disconnected

    ctrl.hostConnected();
    updateCount = 0;
    pushUpdate(cell, "after-reconnect");
    expect(updateCount).toBeGreaterThan(0); // subscription restored
  });

  it("hostDisconnected stops requestUpdate on external cell changes", () => {
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
    const cell = createMockCellHandle("a");
    ctrl.bind(cell);
    updateCount = 0;

    ctrl.hostDisconnected();
    pushUpdate(cell, "ignored");
    expect(updateCount).toBe(0);
  });

  it("onChange fires on backend-pushed value change (without setValue)", () => {
    const host = createMockHost();
    const changes: Array<{ newVal: string; oldVal: string }> = [];
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
      onChange: (n, o) => changes.push({ newVal: n, oldVal: o }),
    });
    const cell = createMockCellHandle("initial");
    ctrl.bind(cell);
    changes.length = 0; // clear bind-time onChange calls

    pushUpdate(cell, "external");
    const change = changes.find((c) => c.newVal === "external");
    expect(change).toBeDefined();
    expect(change!.oldVal).toBe("initial");
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

  it("updateItem replaces item via cell.key().set() and propagates to parent", () => {
    const host = createMockHost();
    const ctrl = new ArrayCellController<string>(host);
    const cell = createMockCellHandle(["x", "y", "z"]);
    ctrl.bind(cell);
    ctrl.updateItem("y", "Y");
    // With parent-child propagation, the child's set() updates the parent
    expect(cell.get()).toEqual(["x", "Y", "z"]);
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
