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

Deno.test("worker reconciler - cell child optimization", async (t) => {
  // Setup minimal runtime to get CellImpl
  const signer = await Identity.fromPassphrase("test reconciler");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://localhost"),
  });

  // Get CellImpl constructor
  const dummyTx = runtime.edit();
  const dummyCell = runtime.getCell(signer.did(), "dummy", undefined, dummyTx);
  const CellImplConstructor = dummyCell.constructor;

  // Define MockCell extending CellImpl
  class MockCell extends (CellImplConstructor as any) {
    private subscribers = new Set<(value: any) => void>();

    constructor(public value: any) {
      // Pass dummy args to super to satisfy it
      // CellImpl(runtime, tx, link, synced, causeContainer, kind)
      super(runtime, undefined, undefined, false, undefined, "cell");
      this.value = value;
    }

    sink(callback: (value: any) => void) {
      this.subscribers.add(callback);
      // Ensure callback is called asynchronously to match Reconciler expectations?
      // Actually reconciler doesn't rely on async usually for initial render.
      // But let's be safe and do it synchronously as it worked for others.
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
  }

  await t.step(
    "updates child Cell in place when tag matches",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      // Child Cell
      const spanVNode: WorkerVNode = {
        type: "vnode",
        name: "span",
        props: { id: "child-span" },
        children: ["Initial"],
      };

      const childCell = new MockCell(spanVNode);

      // Root with child Cell
      const rootVNode: WorkerVNode = {
        type: "vnode",
        name: "div",
        props: {},
        children: [childCell as any], // Pass MockCell directly
      };

      const rootCell = new MockCell(rootVNode);

      // Mount
      reconciler.mount(rootCell as any);
      // Reconciler uses queueMicrotask for batching, so we must wait
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Initial ops check
      const createOps = collector.getOpsOfType("create-element");
      const spanCreate = createOps.find((op: any) => op.tagName === "span");

      console.log("DEBUG: Span create op:", spanCreate);

      if (!spanCreate) {
        throw new Error("Span was not created!");
      }

      const spanNodeId = (spanCreate as any).nodeId;
      collector.clear();

      // Update the child Cell
      const spanVNodeUpdated: WorkerVNode = {
        type: "vnode",
        name: "span", // Same tag
        props: { id: "child-span-updated" },
        children: ["Updated"],
      };
      childCell.set(spanVNodeUpdated);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Check ops
      const removeOps = collector.getOpsOfType("remove-node");
      const spanRemoved = removeOps.some((op: any) => op.nodeId === spanNodeId);
      assertEquals(spanRemoved, false, "Span should NOT be removed");

      const updateProps = collector.getOpsOfType("set-prop");
      const idUpdate = updateProps.find(
        (op: any) => op.key === "id" && op.value === "child-span-updated",
      );
      assertEquals(!!idUpdate, true, "Should update props in place");
    },
  );

  await t.step("replaces child Cell when tag changes", async () => {
    const collector = createOpsCollector();
    const reconciler = new WorkerReconciler({
      onOps: collector.onOps,
    });

    const spanVNode: WorkerVNode = {
      type: "vnode",
      name: "span",
      props: {},
      children: ["Span"],
    };
    const childCell = new MockCell(spanVNode);

    const rootCell = new MockCell({
      type: "vnode",
      name: "div",
      props: {},
      children: [childCell as any],
    });

    reconciler.mount(rootCell as any);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const createSpanOp = collector.getOpsOfType("create-element").find(
      (op: any) => op.tagName === "span",
    );
    const spanNodeId = (createSpanOp as any).nodeId;
    collector.clear();

    // Update child cell to button
    const buttonVNode: WorkerVNode = {
      type: "vnode",
      name: "button", // Different tag
      props: {},
      children: ["Button"],
    };
    childCell.set(buttonVNode);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const removeOps = collector.getOpsOfType("remove-node");
    const spanRemoved = removeOps.some((op: any) => op.nodeId === spanNodeId);
    assertEquals(spanRemoved, true, "Span should be removed when tag changes");

    const newCreateOps = collector.getOpsOfType("create-element");
    const buttonCreated = newCreateOps.some((op: any) =>
      op.tagName === "button"
    );
    assertEquals(buttonCreated, true, "Button should be created");
  });

  await t.step("updates text child Cell in place", async () => {
    const collector = createOpsCollector();
    const reconciler = new WorkerReconciler({
      onOps: collector.onOps,
    });

    const childCell = new MockCell("Hello");
    const rootCell = new MockCell({
      type: "vnode",
      name: "div",
      props: {},
      children: [childCell],
    });

    reconciler.mount(rootCell as any);
    await new Promise((resolve) => setTimeout(resolve, 10));
    collector.clear();

    // Update text
    childCell.set("World");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const removeOps = collector.getOpsOfType("remove-node");
    assertEquals(removeOps.length, 0, "Should not remove text node");

    const updateTextOps = collector.getOpsOfType("update-text");
    assertEquals(updateTextOps.length, 1, "Should emit update-text");
    assertEquals((updateTextOps[0] as any).text, "World");
  });

  await t.step(
    "avoids re-emitting set-event when handler is identical",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const handler = () => {};
      const childCell = new MockCell({
        type: "vnode",
        name: "button",
        props: { onClick: handler },
        children: ["Click me"],
      } as WorkerVNode);

      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: {},
        children: [childCell as any],
      });

      reconciler.mount(rootCell as any);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const setEventOps = collector.getOpsOfType("set-event");
      assertEquals(setEventOps.length, 1, "Should emit initial set-event");
      collector.clear();

      // Update with SAME handler
      childCell.set({
        type: "vnode",
        name: "button",
        props: { onClick: handler }, // Same reference
        children: ["Click me"],
      } as WorkerVNode);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const newSetEventOps = collector.getOpsOfType("set-event");
      assertEquals(
        newSetEventOps.length,
        0,
        "Should NOT emit set-event for identical handler",
      );
    },
  );

  await t.step(
    "deduplicates identical values from Cell",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const childCell = new MockCell("Hello");
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: {},
        children: [childCell],
      });

      reconciler.mount(rootCell as any);
      await new Promise((resolve) => setTimeout(resolve, 10));
      collector.clear();

      // Emit exact SAME value
      childCell.set("Hello");
      await new Promise((resolve) => setTimeout(resolve, 10));

      const ops = collector.getOps();
      assertEquals(ops.length, 0, "Should emit NO ops for identical value");

      // Emit DIFFERENT value
      childCell.set("World");
      await new Promise((resolve) => setTimeout(resolve, 10));

      const updateOps = collector.getOpsOfType("update-text");
      assertEquals(
        updateOps.length,
        1,
        "Should emit update-text for new value",
      );
      assertEquals((updateOps[0] as any).text, "World", "Check new value");
    },
  );

  await t.step(
    "skips redundant inserts on stable updates",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      // Keyed children (using keys in VNode or implicit index?)
      // Reconciler uses index if no keys.
      // Let's use explicit keys to be safe/clear.
      const child1 = {
        type: "vnode",
        name: "div",
        props: { key: "a" },
        children: ["A"],
      };
      const child2 = {
        type: "vnode",
        name: "div",
        props: { key: "b" },
        children: ["B"],
      };

      const rootVNode = {
        type: "vnode",
        name: "div",
        props: {},
        children: [child1, child2],
      };
      const rootCell = new MockCell(rootVNode);

      reconciler.mount(rootCell as any);
      await new Promise((resolve) => setTimeout(resolve, 10));
      collector.clear();

      // Update parent with SAME children order
      const rootVNodeUpdated = {
        type: "vnode",
        name: "div",
        props: {},
        children: [child1, child2], // Same objects, same keys
      };
      rootCell.set(rootVNodeUpdated);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const insertOps = collector.getOpsOfType("insert-child");
      assertEquals(insertOps.length, 0, "Should skip inserts if order is same");

      // Update parent with SWAPPED children
      const rootVNodeSwapped = {
        type: "vnode",
        name: "div",
        props: {},
        children: [child2, child1], // Swap
      };
      rootCell.set(rootVNodeSwapped);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const swapInserts = collector.getOpsOfType("insert-child");
      // Naive reorder: remove/insert or move.
      // With implementation "insert from end", it likely emits inserts.
      // At least 1 insert is expected (to move).
      assertEquals(swapInserts.length > 0, true, "Should insert to re-order");
    },
  );
});
