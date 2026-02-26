import { assertEquals } from "@std/assert";
import { WorkerReconciler } from "../src/worker/reconciler.ts";
import type { WorkerVNode } from "../src/worker/types.ts";

import type { VDomOp } from "../src/vdom-ops.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "@commontools/runner";

/**
 * Helper to collect ops emitted by the reconciler.
 */
function createOpsCollector() {
  const allOps: VDomOp[] = [];
  return {
    onOps: (ops: VDomOp[]) => allOps.push(...ops),
    getOps: () => allOps,
    clear: () => {
      allOps.length = 0;
    },
    hasOp: (opType: string) => allOps.some((op) => op.op === opType),
    getOpsOfType: (opType: string) => allOps.filter((op) => op.op === opType),
  };
}

Deno.test("worker reconciler - Cell<Props> handling", async (t) => {
  // Setup minimal runtime to get CellImpl
  const signer = await Identity.fromPassphrase("test cell-props");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://localhost"),
  });

  // Get CellImpl constructor
  const dummyTx = runtime.edit();
  const dummyCell = runtime.getCell(signer.did(), "dummy", undefined, dummyTx);
  const CellImplConstructor = dummyCell.constructor;

  // MockCell extending CellImpl for basic Cell behavior
  class MockCell extends (CellImplConstructor as any) {
    private subscribers = new Set<(value: any) => void>();

    constructor(public value: any) {
      super(runtime, undefined, undefined, false, undefined, "cell");
      this.value = value;
    }

    sink(callback: (value: any) => void) {
      this.subscribers.add(callback);
      callback(this.value);
      return () => {
        this.subscribers.delete(callback);
      };
    }

    set(newValue: any) {
      this.value = newValue;
      for (const sub of this.subscribers) {
        sub(newValue);
      }
    }

    isStream() {
      return false;
    }
  }

  /**
   * MockPropsCell: simulates Cell<Props> with key(), resolveAsCell() support.
   * When sunk, emits the props object. key() returns a MockPropCell for that key.
   */
  class MockPropsCell extends MockCell {
    private propCells = new Map<string, MockPropCell>();

    key(propName: string) {
      if (!this.propCells.has(propName)) {
        this.propCells.set(
          propName,
          new MockPropCell(this.value?.[propName]),
        );
      }
      return this.propCells.get(propName)!;
    }

    override set(newValue: any) {
      super.set(newValue);
      // Propagate updates to existing child prop cells
      for (const [k, propCell] of this.propCells) {
        propCell.set(newValue?.[k]);
      }
    }
  }

  /**
   * MockPropCell: represents a single prop's Cell.
   * Supports asSchema(), resolveAsCell(), getAsNormalizedFullLink().
   */
  class MockPropCell extends MockCell {
    asSchema(_schema: any) {
      return this;
    }

    resolveAsCell() {
      // If the value is itself a Cell/Stream, return it (for events/bindings)
      if (
        this.value && typeof this.value === "object" && "sink" in this.value
      ) {
        return this.value;
      }
      return this;
    }

    getAsNormalizedFullLink() {
      return { space: "test-space", id: "test-id", path: [] };
    }
  }

  /**
   * MockStream: a Cell-like object that isStream() returns true for.
   */
  class MockStream extends MockCell {
    public sent: unknown[] = [];

    constructor() {
      super(undefined);
    }

    override isStream() {
      return true;
    }

    send(event: unknown) {
      this.sent.push(event);
    }
  }

  // --- Test cases ---

  await t.step("Cell<Props> renders primitive props", async () => {
    const collector = createOpsCollector();
    const reconciler = new WorkerReconciler({
      onOps: collector.onOps,
    });

    const propsCell = new MockPropsCell({
      className: "foo",
      title: "bar",
    });

    const rootCell = new MockCell({
      type: "vnode",
      name: "div",
      props: propsCell,
      children: [],
    });

    reconciler.mount(rootCell as any);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const setPropOps = collector.getOpsOfType("set-prop");
    const classOp = setPropOps.find((op: any) => op.key === "className");
    const titleOp = setPropOps.find((op: any) => op.key === "title");

    assertEquals(
      classOp !== undefined,
      true,
      "Should emit set-prop for className",
    );
    assertEquals((classOp as any)?.value, "foo");
    assertEquals(
      titleOp !== undefined,
      true,
      "Should emit set-prop for title",
    );
    assertEquals((titleOp as any)?.value, "bar");
  });

  await t.step("Cell<Props> primitive prop updates", async () => {
    const collector = createOpsCollector();
    const reconciler = new WorkerReconciler({
      onOps: collector.onOps,
    });

    const propsCell = new MockPropsCell({ className: "foo" });
    const rootCell = new MockCell({
      type: "vnode",
      name: "div",
      props: propsCell,
      children: [],
    });

    reconciler.mount(rootCell as any);
    await new Promise((resolve) => setTimeout(resolve, 10));
    collector.clear();

    // Update primitive prop
    propsCell.set({ className: "bar" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const setPropOps = collector.getOpsOfType("set-prop");
    const classOp = setPropOps.find((op: any) => op.key === "className");
    assertEquals(
      classOp !== undefined,
      true,
      "Should emit set-prop for updated className",
    );
    assertEquals((classOp as any)?.value, "bar");
  });

  await t.step("Cell<Props> prop addition", async () => {
    const collector = createOpsCollector();
    const reconciler = new WorkerReconciler({
      onOps: collector.onOps,
    });

    const propsCell = new MockPropsCell({ className: "foo" });
    const rootCell = new MockCell({
      type: "vnode",
      name: "div",
      props: propsCell,
      children: [],
    });

    reconciler.mount(rootCell as any);
    await new Promise((resolve) => setTimeout(resolve, 10));
    collector.clear();

    // Add a new prop
    propsCell.set({ className: "foo", title: "new" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const setPropOps = collector.getOpsOfType("set-prop");
    const titleOp = setPropOps.find((op: any) => op.key === "title");
    assertEquals(
      titleOp !== undefined,
      true,
      "Should emit set-prop for new title",
    );
    assertEquals((titleOp as any)?.value, "new");
  });

  await t.step("Cell<Props> prop removal", async () => {
    const collector = createOpsCollector();
    const reconciler = new WorkerReconciler({
      onOps: collector.onOps,
    });

    const propsCell = new MockPropsCell({
      className: "foo",
      title: "bar",
    });
    const rootCell = new MockCell({
      type: "vnode",
      name: "div",
      props: propsCell,
      children: [],
    });

    reconciler.mount(rootCell as any);
    await new Promise((resolve) => setTimeout(resolve, 10));
    collector.clear();

    // Remove title prop
    propsCell.set({ className: "foo" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const removePropOps = collector.getOpsOfType("remove-prop");
    const titleRemoved = removePropOps.some((op: any) => op.key === "title");
    assertEquals(titleRemoved, true, "Should emit remove-prop for title");
  });

  await t.step("Cell<Props> object prop (style)", async () => {
    const collector = createOpsCollector();
    const reconciler = new WorkerReconciler({
      onOps: collector.onOps,
    });

    const propsCell = new MockPropsCell({
      style: { color: "red" },
    });
    const rootCell = new MockCell({
      type: "vnode",
      name: "div",
      props: propsCell,
      children: [],
    });

    reconciler.mount(rootCell as any);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const setPropOps = collector.getOpsOfType("set-prop");
    const styleOp = setPropOps.find((op: any) => op.key === "style");
    assertEquals(
      styleOp !== undefined,
      true,
      "Should emit set-prop for style (via per-prop sink)",
    );
    // Style objects get transformed to CSS strings by transformPropValue
    // The per-prop sink delivers the full object; transformPropValue converts it
  });

  await t.step("Cell<Props> array prop", async () => {
    const collector = createOpsCollector();
    const reconciler = new WorkerReconciler({
      onOps: collector.onOps,
    });

    const propsCell = new MockPropsCell({
      items: [1, 2, 3],
    });
    const rootCell = new MockCell({
      type: "vnode",
      name: "div",
      props: propsCell,
      children: [],
    });

    reconciler.mount(rootCell as any);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const setPropOps = collector.getOpsOfType("set-prop");
    const itemsOp = setPropOps.find((op: any) => op.key === "items");
    assertEquals(
      itemsOp !== undefined,
      true,
      "Should emit set-prop for array items (via per-prop sink)",
    );
  });

  await t.step("Cell<Props> event handler (stream)", async () => {
    const collector = createOpsCollector();
    const reconciler = new WorkerReconciler({
      onOps: collector.onOps,
    });

    const mockStream = new MockStream();
    const propsCell = new MockPropsCell({
      onclick: mockStream,
    });
    const rootCell = new MockCell({
      type: "vnode",
      name: "button",
      props: propsCell,
      children: ["Click"],
    });

    reconciler.mount(rootCell as any);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const setEventOps = collector.getOpsOfType("set-event");
    assertEquals(setEventOps.length >= 1, true, "Should emit set-event");
    assertEquals((setEventOps[0] as any).eventType, "click");
  });

  await t.step("Cell<Props> binding prop", async () => {
    const collector = createOpsCollector();
    const reconciler = new WorkerReconciler({
      onOps: collector.onOps,
    });

    const bindingCell = runtime.getCell(
      signer.did(),
      "binding-test-cell",
      undefined,
      dummyTx,
    );
    bindingCell.set("hello");

    const propsCell = new MockPropsCell({
      $value: bindingCell,
    });
    const rootCell = new MockCell({
      type: "vnode",
      name: "ct-input",
      props: propsCell,
      children: [],
    });

    reconciler.mount(rootCell as any);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const setBindingOps = collector.getOpsOfType("set-binding");
    assertEquals(setBindingOps.length >= 1, true, "Should emit set-binding");
    assertEquals((setBindingOps[0] as any).propName, "value");
  });

  await t.step(
    "Cell<Props> same cell on update → no re-bind",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const propsCell = new MockPropsCell({ className: "foo" });
      const rootVNode: WorkerVNode = {
        type: "vnode",
        name: "div",
        props: propsCell as any,
        children: [],
      };
      const rootCell = new MockCell(rootVNode);

      reconciler.mount(rootCell as any);
      await new Promise((resolve) => setTimeout(resolve, 10));
      collector.clear();

      // Update root but keep same propsCell reference
      rootCell.set({
        type: "vnode",
        name: "div",
        props: propsCell as any,
        children: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Same Cell<Props> → updatePropsInPlace should detect same cell and skip
      const setPropOps = collector.getOpsOfType("set-prop");
      assertEquals(
        setPropOps.length,
        0,
        "Should emit NO set-prop ops when same Cell<Props> is re-used",
      );
    },
  );

  await t.step("Cell<Props> mixed prop types", async () => {
    const collector = createOpsCollector();
    const reconciler = new WorkerReconciler({
      onOps: collector.onOps,
    });

    const mockStream = new MockStream();
    const bindingCell = runtime.getCell(
      signer.did(),
      "binding-mixed-cell",
      undefined,
      dummyTx,
    );
    bindingCell.set("test");

    const propsCell = new MockPropsCell({
      className: "container",
      style: { color: "blue" },
      onclick: mockStream,
      $value: bindingCell,
    });
    const rootCell = new MockCell({
      type: "vnode",
      name: "ct-input",
      props: propsCell,
      children: [],
    });

    reconciler.mount(rootCell as any);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify primitive prop
    const setPropOps = collector.getOpsOfType("set-prop");
    const classOp = setPropOps.find((op: any) => op.key === "className");
    assertEquals(classOp !== undefined, true, "Should have className set-prop");

    // Verify style (object → per-prop sink)
    const styleOp = setPropOps.find((op: any) => op.key === "style");
    assertEquals(styleOp !== undefined, true, "Should have style set-prop");

    // Verify event handler
    const setEventOps = collector.getOpsOfType("set-event");
    assertEquals(setEventOps.length >= 1, true, "Should have set-event");

    // Verify binding
    const setBindingOps = collector.getOpsOfType("set-binding");
    assertEquals(setBindingOps.length >= 1, true, "Should have set-binding");
    assertEquals((setBindingOps[0] as any).propName, "value");
  });
});
