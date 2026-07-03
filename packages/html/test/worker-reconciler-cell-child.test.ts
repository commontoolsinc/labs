import { assertEquals } from "@std/assert";
import { WorkerReconciler } from "../src/worker/reconciler.ts";
import type { WorkerRenderNode, WorkerVNode } from "../src/worker/types.ts";

import type { VDomOp } from "../src/vdom-ops.ts";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime, UI } from "@commonfabric/runner";
import type { Cell } from "@commonfabric/runner";

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

    isStream() {
      return false;
    }
  }

  const renderCell = (cell: MockCell): Cell<WorkerRenderNode> => cell as any;
  const unknownCell = (cell: MockCell): Cell<unknown> => cell as any;
  const cellNode = (cell: MockCell): WorkerRenderNode => cell as any;
  const uiNode = (
    node: WorkerVNode,
    toJSON?: () => string,
  ): WorkerRenderNode => ({
    [UI]: node,
    ...(toJSON ? { toJSON } : {}),
  } as any);

  await t.step(
    "updates child Cell VNode in place when tag matches",
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
        children: [childCell as any],
      };

      const rootCell = new MockCell(rootVNode);

      // Mount
      reconciler.mount(renderCell(rootCell));
      await new Promise((resolve) => setTimeout(resolve, 10));

      const createOps = collector.getOpsOfType("create-element");
      const spanCreate = createOps.find((op: any) => op.tagName === "span");

      if (!spanCreate) {
        throw new Error("Span was not created!");
      }

      const spanNodeId = (spanCreate as any).nodeId;
      collector.clear();

      // Update Cell: same tag but different props and children
      childCell.set({
        type: "vnode",
        name: "span",
        props: { id: "child-span-updated" },
        children: ["Updated"],
      } as WorkerVNode);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // VNode in-place update: span element should NOT be removed/recreated
      const removeOps = collector.getOpsOfType("remove-node");
      const spanRemoved = removeOps.some((op: any) => op.nodeId === spanNodeId);
      assertEquals(
        spanRemoved,
        false,
        "Span should NOT be removed (in-place update)",
      );

      const newCreateOps = collector.getOpsOfType("create-element");
      const newSpanCreated = newCreateOps.some((op: any) =>
        op.tagName === "span"
      );
      assertEquals(
        newSpanCreated,
        false,
        "No new span should be created (in-place update)",
      );

      // Props should be updated in place
      const setPropOps = collector.getOpsOfType("set-prop");
      const idUpdate = setPropOps.find((op: any) =>
        op.nodeId === spanNodeId && op.key === "id"
      );
      assertEquals(
        (idUpdate as any)?.value,
        "child-span-updated",
        "Prop should be updated in place",
      );
    },
  );

  await t.step(
    "does not re-emit set-prop for unchanged static props on a reused child VNode (CT-1798)",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const childCell = new MockCell({
        type: "vnode",
        name: "span",
        props: { id: "tab", "data-role": "tab" },
        children: ["A"],
      } as WorkerVNode);
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: {},
        children: [renderCell(childCell)],
      });

      reconciler.mount(renderCell(rootCell));
      await new Promise((resolve) => setTimeout(resolve, 10));
      collector.clear();

      // Re-set the reused child VNode with IDENTICAL props but changed children,
      // so the reconcile path (updateChildrenInPlace -> updatePropsInPlace) runs
      // in full. #4366 made this fire on every recompute; unchanged static props
      // should no longer produce worker->main set-prop ops.
      childCell.set({
        type: "vnode",
        name: "span",
        props: { id: "tab", "data-role": "tab" },
        children: ["B"],
      } as WorkerVNode);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const unchangedPropOps = collector.getOpsOfType("set-prop").filter((op) =>
        "key" in op && (op.key === "id" || op.key === "data-role")
      );
      assertEquals(
        unchangedPropOps.length,
        0,
        "unchanged static props should not re-emit set-prop ops",
      );
      // Sanity: the reconcile path actually ran (children changed A -> B).
      assertEquals(
        collector.getOps().length > 0,
        true,
        "child reconcile should still emit ops for the changed children",
      );

      // A genuine prop change must still emit, while a still-unchanged sibling
      // prop stays quiet.
      collector.clear();
      childCell.set({
        type: "vnode",
        name: "span",
        props: { id: "tab-2", "data-role": "tab" },
        children: ["B"],
      } as WorkerVNode);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const idOps = collector.getOpsOfType("set-prop").filter((op) =>
        "key" in op && op.key === "id"
      );
      assertEquals(idOps.length, 1, "changed static prop should re-emit once");
      assertEquals(
        (idOps[0] as any).value,
        "tab-2",
        "changed static prop should carry the new value",
      );
      assertEquals(
        collector.getOpsOfType("set-prop").filter((op) =>
          "key" in op && op.key === "data-role"
        ).length,
        0,
        "still-unchanged static prop should remain quiet",
      );
    },
  );

  await t.step(
    "re-emits DOM-live props (value/checked) on a reused child even when unchanged, so the main thread can repair live-DOM drift (CT-1798 review)",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const liveProps = {
        id: "field",
        value: "hello",
        checked: true,
        scrollTop: 0,
        scrollLeft: 0,
      };
      const childCell = new MockCell({
        type: "vnode",
        name: "input",
        props: { ...liveProps },
        children: [],
      } as WorkerVNode);
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: {},
        children: [renderCell(childCell)],
      });

      reconciler.mount(renderCell(rootCell));
      await new Promise((resolve) => setTimeout(resolve, 10));
      collector.clear();

      // Reuse the same input VNode with IDENTICAL props. The worker can't see
      // live DOM drift (user typing, browser-set checked, user scrolling), so
      // the DOM-live props must still re-emit to let setPropDefault repair it;
      // the inert id stays quiet.
      childCell.set({
        type: "vnode",
        name: "input",
        props: { ...liveProps },
        children: [],
      } as WorkerVNode);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const keys = collector.getOpsOfType("set-prop")
        .filter((op) => "key" in op)
        .map((op) => (op as { key: string }).key);
      for (const liveKey of ["value", "checked", "scrollTop", "scrollLeft"]) {
        assertEquals(
          keys.includes(liveKey),
          true,
          `DOM-live \`${liveKey}\` must re-emit so drift can be repaired`,
        );
      }
      assertEquals(
        keys.includes("id"),
        false,
        "inert `id` should still be skipped when unchanged",
      );
    },
  );

  await t.step(
    "re-emits object/array static props on a reused child even with a stable reference (CT-1798 review)",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const styleObj = { color: "red" };
      const childCell = new MockCell({
        type: "vnode",
        name: "span",
        props: { id: "s", style: styleObj },
        children: ["A"],
      } as WorkerVNode);
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: {},
        children: [renderCell(childCell)],
      });

      reconciler.mount(renderCell(rootCell));
      await new Promise((resolve) => setTimeout(resolve, 10));
      collector.clear();

      // Same object reference, changed child to force the reconcile. Object
      // props compare by reference (unreliable), so they must never be skipped.
      childCell.set({
        type: "vnode",
        name: "span",
        props: { id: "s", style: styleObj },
        children: ["B"],
      } as WorkerVNode);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const keys = collector.getOpsOfType("set-prop")
        .filter((op) => "key" in op)
        .map((op) => (op as { key: string }).key);
      assertEquals(
        keys.includes("style"),
        true,
        "object/array props must always re-emit",
      );
      assertEquals(
        keys.includes("id"),
        false,
        "inert primitive `id` should still be skipped when unchanged",
      );
    },
  );

  await t.step(
    "re-emits text-integrity props (cf-chat-message name/content) on a reused child even when unchanged (CT-1798 review)",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const childCell = new MockCell({
        type: "vnode",
        name: "cf-chat-message",
        props: { id: "m1", name: "Alice", content: "hi" },
        children: [],
      } as WorkerVNode);
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: {},
        children: [renderCell(childCell)],
      });

      reconciler.mount(renderCell(rootCell));
      await new Promise((resolve) => setTimeout(resolve, 10));
      collector.clear();

      // Text-integrity sink props have policy-dependent transforms and must
      // re-run on every reconcile; only inert id may be skipped.
      childCell.set({
        type: "vnode",
        name: "cf-chat-message",
        props: { id: "m1", name: "Alice", content: "hi" },
        children: [],
      } as WorkerVNode);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const keys = collector.getOpsOfType("set-prop")
        .filter((op) => "key" in op)
        .map((op) => (op as { key: string }).key);
      assertEquals(
        keys.includes("name"),
        true,
        "text-integrity `name` must always re-emit",
      );
      assertEquals(
        keys.includes("content"),
        true,
        "text-integrity `content` must always re-emit",
      );
      assertEquals(
        keys.includes("id"),
        false,
        "inert `id` should still be skipped when unchanged",
      );
    },
  );

  await t.step(
    "replaces same-key child Cell when parent supplies a different cell",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const firstChild = new MockCell("first");
      const secondChild = new MockCell("second");
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: {},
        children: [renderCell(firstChild)],
      });

      reconciler.mount(renderCell(rootCell));
      await new Promise((resolve) => setTimeout(resolve, 10));
      collector.clear();

      rootCell.set({
        type: "vnode",
        name: "div",
        props: {},
        children: [renderCell(secondChild)],
      } as WorkerVNode);
      await new Promise((resolve) => setTimeout(resolve, 10));

      assertEquals(
        collector.getOpsOfType("remove-node").length > 0,
        true,
        "old cell child should be removed when the parent supplies a new cell",
      );
      assertEquals(
        collector.getOpsOfType("create-text").some((op) =>
          "text" in op && op.text === "second"
        ),
        true,
        "new cell child should render its current value",
      );
    },
  );

  await t.step(
    "replaces same-key text Cell when parent supplies a literal child",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const oldChild = new MockCell("cell text");
      const rootCell = new MockCell(
        {
          type: "vnode",
          name: "div",
          props: {},
          children: [cellNode(oldChild)],
        } satisfies WorkerVNode,
      );

      reconciler.mount(renderCell(rootCell));
      await new Promise((resolve) => setTimeout(resolve, 10));
      collector.clear();

      rootCell.set(
        {
          type: "vnode",
          name: "div",
          props: {},
          children: ["literal text"],
        } satisfies WorkerVNode,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      assertEquals(
        collector.getOpsOfType("remove-node").length > 0,
        true,
        "old cell-backed text child should be removed",
      );
      assertEquals(
        collector.getOpsOfType("create-text").some((op) =>
          "text" in op && op.text === "literal text"
        ),
        true,
        "literal replacement should render as a new static text node",
      );

      collector.clear();
      oldChild.set("stale cell update");
      await new Promise((resolve) => setTimeout(resolve, 10));

      assertEquals(
        collector.getOps().length,
        0,
        "old cell subscription should be cancelled after literal replacement",
      );
    },
  );

  await t.step(
    "updates cell-backed conditional row children at first middle and last positions",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const voteSpan = (id: string): WorkerVNode => ({
        type: "vnode",
        name: "span",
        props: { "data-vote-swatch-name": id },
        children: [id],
      });

      const firstChildren = new MockCell([]);
      const middleChildren = new MockCell([]);
      const lastChildren = new MockCell([]);

      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: {},
        children: [
          {
            type: "vnode",
            name: "div",
            props: { "data-option-id": "first" },
            children: firstChildren,
          },
          {
            type: "vnode",
            name: "div",
            props: { "data-option-id": "middle" },
            children: middleChildren,
          },
          {
            type: "vnode",
            name: "div",
            props: { "data-option-id": "last" },
            children: lastChildren,
          },
        ],
      });

      reconciler.mount(renderCell(rootCell));
      await new Promise((resolve) => setTimeout(resolve, 10));
      collector.clear();

      firstChildren.set([voteSpan("Alice")]);
      middleChildren.set([null, voteSpan("Alice")]);
      lastChildren.set([null, null, voteSpan("Alice")]);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const spanCreates = collector.getOpsOfType("create-element").filter(
        (op) => "tagName" in op && op.tagName === "span",
      );
      assertEquals(
        spanCreates.length,
        3,
        "should create one swatch span for each cell-backed row",
      );

      const swatchPropOps = collector.getOpsOfType("set-prop").filter(
        (op) =>
          op.op === "set-prop" && op.key === "data-vote-swatch-name" &&
          op.value === "Alice",
      );
      assertEquals(
        swatchPropOps.length,
        3,
        "each cell-backed swatch span should receive the voter data attribute",
      );
    },
  );

  await t.step(
    "inserts pending mapped child cells when they resolve after parent array update",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const voteSpan = (id: string): WorkerVNode => ({
        type: "vnode",
        name: "span",
        props: { "data-vote-swatch-name": id },
        children: [id],
      });

      const firstMappedResult = new MockCell(undefined);
      const middleMappedResult = new MockCell(undefined);
      const lastMappedResult = new MockCell(undefined);

      const mappedChildren = new MockCell([]);
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: { "data-option-id": "mapped" },
        children: mappedChildren,
      });

      reconciler.mount(renderCell(rootCell));
      await new Promise((resolve) => setTimeout(resolve, 10));
      collector.clear();

      mappedChildren.set([
        firstMappedResult,
        middleMappedResult,
        lastMappedResult,
      ]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      collector.clear();

      firstMappedResult.set(voteSpan("Alice"));
      middleMappedResult.set(voteSpan("Alice"));
      lastMappedResult.set(voteSpan("Alice"));
      await new Promise((resolve) => setTimeout(resolve, 10));

      const spanCreates = collector.getOpsOfType("create-element").filter(
        (op) => "tagName" in op && op.tagName === "span",
      );
      assertEquals(
        spanCreates.length,
        3,
        "should create one swatch span for each late-resolving mapped child cell",
      );

      const spanInserts = collector.getOpsOfType("insert-child").filter(
        (op) =>
          op.op === "insert-child" &&
          spanCreates.some((createOp) =>
            "nodeId" in createOp && createOp.nodeId === op.childId
          ),
      );
      assertEquals(
        spanInserts.length,
        3,
        "each late-resolving swatch span should be inserted into the parent row",
      );
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
    "updates same-shape slotted header cell VNode children",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const header = new MockCell(
        {
          type: "vnode",
          name: "div",
          props: { slot: "header" },
          children: [{
            type: "vnode",
            name: "span",
            props: { "data-poll-summary": "true" },
            children: ["4 joined · 0 options · 0 votes · hosted by Alice"],
          }],
        } satisfies WorkerVNode,
      );

      const rootCell = new MockCell(
        {
          type: "vnode",
          name: "cf-screen",
          props: {},
          children: [cellNode(header)],
        } satisfies WorkerVNode,
      );

      reconciler.mount(unknownCell(rootCell));
      await new Promise((resolve) => setTimeout(resolve, 10));
      const screenCreate = collector.getOpsOfType("create-element").find(
        (op) => "tagName" in op && op.tagName === "cf-screen",
      );
      if (!screenCreate || !("nodeId" in screenCreate)) {
        throw new Error("Expected cf-screen to be created");
      }
      const screenNodeId = screenCreate.nodeId;
      collector.clear();

      header.set(
        {
          type: "vnode",
          name: "div",
          props: { slot: "header" },
          children: [{
            type: "vnode",
            name: "span",
            props: { "data-poll-summary": "true" },
            children: ["4 joined · 1 options · 0 votes · hosted by Alice"],
          }],
        } satisfies WorkerVNode,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      const textOps = collector.getOps().filter((op) =>
        (op.op === "update-text" || op.op === "create-text") &&
        "text" in op
      );
      assertEquals(
        textOps.some((op) =>
          "text" in op &&
          op.text === "4 joined · 1 options · 0 votes · hosted by Alice"
        ),
        true,
        "slotted header summary text should update",
      );

      assertEquals(
        collector.getOpsOfType("remove-node").some((op) =>
          "nodeId" in op && op.nodeId === screenNodeId
        ),
        false,
        "slotted header summary update should not remount cf-screen",
      );
    },
  );

  await t.step(
    "updates same-shape split text children from a Cell VNode",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const summary = new MockCell(
        {
          type: "vnode",
          name: "div",
          props: { "data-poll-summary": "true" },
          children: [
            4,
            " joined · ",
            4,
            " options · ",
            1,
            " votes · hosted by Dave",
          ],
        } satisfies WorkerVNode,
      );
      const rootCell = new MockCell(
        {
          type: "vnode",
          name: "div",
          props: {},
          children: [cellNode(summary)],
        } satisfies WorkerVNode,
      );

      reconciler.mount(unknownCell(rootCell));
      await new Promise((resolve) => setTimeout(resolve, 10));
      collector.clear();

      summary.set(
        {
          type: "vnode",
          name: "div",
          props: { "data-poll-summary": "true" },
          children: [
            4,
            " joined · ",
            4,
            " options · ",
            4,
            " votes · hosted by Dave",
          ],
        } satisfies WorkerVNode,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      const textOps = collector.getOpsOfType("update-text");
      assertEquals(
        textOps.some((op) => "text" in op && op.text === "4"),
        true,
        "same-shape split vote-count text should update",
      );
      assertEquals(
        collector.getOps().some((op) =>
          (op.op === "update-text" || op.op === "create-text") &&
          "text" in op && op.text === "4"
        ),
        true,
        "same-shape split vote-count text should be represented",
      );
    },
  );

  await t.step(
    "replaces same-key UI child when rendered root tag changes",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const beforeChild = uiNode({
        type: "vnode",
        name: "span",
        props: {},
        children: ["Before"],
      });
      const afterChild = uiNode({
        type: "vnode",
        name: "button",
        props: {},
        children: ["After"],
      });

      const rootCell = new MockCell(
        {
          type: "vnode",
          name: "div",
          props: {},
          children: [beforeChild],
        } satisfies WorkerVNode,
      );

      reconciler.mount(unknownCell(rootCell));
      await new Promise((resolve) => setTimeout(resolve, 10));

      const spanCreate = collector.getOpsOfType("create-element").find(
        (op) => "tagName" in op && op.tagName === "span",
      );
      if (!spanCreate || !("nodeId" in spanCreate)) {
        throw new Error("Expected span to be created");
      }
      const spanNodeId = spanCreate.nodeId;
      collector.clear();

      rootCell.set(
        {
          type: "vnode",
          name: "div",
          props: {},
          children: [afterChild],
        } satisfies WorkerVNode,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      assertEquals(
        collector.getOpsOfType("remove-node").some((op) =>
          "nodeId" in op && op.nodeId === spanNodeId
        ),
        true,
        "same-key UI payload should remove the stale root element",
      );
      assertEquals(
        collector.getOpsOfType("create-element").some((op) =>
          "tagName" in op && op.tagName === "button"
        ),
        true,
        "same-key UI payload should create the replacement root element",
      );
    },
  );

  await t.step(
    "avoids re-emitting set-event when handler is identical (VNode path)",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      // Test event handler identity optimization via direct VNode reconciliation
      // (not Cell child path, which always replaces)
      const handler = () => {};
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: {},
        children: [{
          type: "vnode",
          name: "button",
          props: { onClick: handler },
          children: ["Click me"],
        }],
      });

      reconciler.mount(rootCell as any);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const setEventOps = collector.getOpsOfType("set-event");
      assertEquals(setEventOps.length, 1, "Should emit initial set-event");
      collector.clear();

      // Update root with same handler reference on the child VNode
      rootCell.set({
        type: "vnode",
        name: "div",
        props: {},
        children: [{
          type: "vnode",
          name: "button",
          props: { onClick: handler }, // Same reference
          children: ["Click me"],
        }],
      });
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
    "emits remove-event (not remove-prop) when an event prop is removed",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const rootCell = new MockCell({
        type: "vnode",
        name: "button",
        props: { onClick: () => {} },
        children: ["Click me"],
      });

      reconciler.mount(rootCell as any);
      await new Promise((resolve) => setTimeout(resolve, 10));
      collector.clear();

      rootCell.set({
        type: "vnode",
        name: "button",
        props: {},
        children: ["Click me"],
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const removeEventOps = collector.getOpsOfType("remove-event");
      assertEquals(removeEventOps.length, 1, "Should emit remove-event");
      assertEquals(
        (removeEventOps[0] as { eventType: string }).eventType,
        "click",
      );

      const removePropOps = collector.getOpsOfType("remove-prop");
      const hasOnClickRemoveProp = removePropOps.some((op) =>
        (op as { key: string }).key === "onClick"
      );
      assertEquals(
        hasOnClickRemoveProp,
        false,
        "Should not emit remove-prop for onClick",
      );
    },
  );

  await t.step(
    "emits remove-event when event prop value becomes undefined",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const handler = () => {};
      const rootCell = new MockCell({
        type: "vnode",
        name: "button",
        props: { onClick: handler },
        children: ["Click me"],
      });

      reconciler.mount(rootCell as any);
      await new Promise((resolve) => setTimeout(resolve, 10));
      collector.clear();

      rootCell.set({
        type: "vnode",
        name: "button",
        props: { onClick: undefined },
        children: ["Click me"],
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const removeEventOps = collector.getOpsOfType("remove-event");
      assertEquals(removeEventOps.length, 1, "Should emit remove-event");
      assertEquals(
        (removeEventOps[0] as { eventType: string }).eventType,
        "click",
      );

      const setEventOps = collector.getOpsOfType("set-event");
      assertEquals(setEventOps.length, 0, "Should not re-register event");
    },
  );

  await t.step(
    "emits remove-event when Cell-backed event handler resolves to undefined",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const handlerCell = new MockCell(() => {});
      const rootCell = new MockCell({
        type: "vnode",
        name: "button",
        props: { onClick: handlerCell },
        children: ["Click me"],
      });

      reconciler.mount(rootCell as any);
      await new Promise((resolve) => setTimeout(resolve, 10));
      collector.clear();

      handlerCell.set(undefined);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const removeEventOps = collector.getOpsOfType("remove-event");
      assertEquals(removeEventOps.length, 1, "Should emit remove-event");
      assertEquals(
        (removeEventOps[0] as { eventType: string }).eventType,
        "click",
      );

      const setEventOps = collector.getOpsOfType("set-event");
      assertEquals(setEventOps.length, 0, "Should not re-register event");
    },
  );

  await t.step(
    "preserves falsy non-null children values from children Cells",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const childrenCell = new MockCell(0);
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: {},
        children: childrenCell,
      });

      reconciler.mount(rootCell as any);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const initialTextOps = collector.getOpsOfType("create-text");
      assertEquals(
        initialTextOps.length > 0,
        true,
        "Should create text node for numeric child 0",
      );
      assertEquals(
        (initialTextOps[0] as { text: string }).text,
        "0",
      );

      collector.clear();
      childrenCell.set("");
      await new Promise((resolve) => setTimeout(resolve, 10));

      const emptyStringTextOps = collector.getOpsOfType("create-text");
      assertEquals(
        emptyStringTextOps.length > 0,
        true,
        "Should keep empty string child instead of dropping it",
      );
      assertEquals(
        (emptyStringTextOps[0] as { text: string }).text,
        "",
      );
    },
  );

  await t.step(
    "normalizes binding key when removing $props",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const valueCell = runtime.getCell(
        signer.did(),
        "binding-removal-cell",
        undefined,
        dummyTx,
      );
      valueCell.set("hello");

      const rootCell = new MockCell({
        type: "vnode",
        name: "cf-input",
        props: { $value: valueCell },
        children: [],
      });

      reconciler.mount(rootCell as any);
      await new Promise((resolve) => setTimeout(resolve, 10));
      collector.clear();

      rootCell.set({
        type: "vnode",
        name: "cf-input",
        props: {},
        children: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const removePropOps = collector.getOpsOfType("remove-prop");
      const hasValueRemove = removePropOps.some((op) =>
        (op as { key: string }).key === "value"
      );
      const hasBindingSyntaxRemove = removePropOps.some((op) =>
        (op as { key: string }).key === "$value"
      );

      assertEquals(hasValueRemove, true, "Should remove normalized key");
      assertEquals(
        hasBindingSyntaxRemove,
        false,
        "Should not remove $value literal key",
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

  await t.step(
    "updates same-key subpattern UI payloads without reinserting",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });
      const subpatternOutput = (node: WorkerVNode): WorkerRenderNode =>
        uiNode(node, () => "stable-subpattern-output");

      const rootCell = new MockCell(
        {
          type: "vnode",
          name: "div",
          props: {},
          children: [
            subpatternOutput({
              type: "vnode",
              name: "span",
              props: { "data-row": "same", "data-count": "1" },
              children: ["one"],
            }),
          ],
        } satisfies WorkerVNode,
      );

      reconciler.mount(unknownCell(rootCell));
      await new Promise((resolve) => setTimeout(resolve, 10));
      const spanCreate = collector.getOps().find((op) =>
        op.op === "create-element" && "tagName" in op &&
        op.tagName === "span"
      );
      if (!spanCreate || !("nodeId" in spanCreate)) {
        throw new Error("Expected initial span to be created");
      }
      const spanNodeId = spanCreate.nodeId;
      collector.clear();

      rootCell.set(
        {
          type: "vnode",
          name: "div",
          props: {},
          children: [
            subpatternOutput({
              type: "vnode",
              name: "span",
              props: { "data-row": "same", "data-count": "2" },
              children: ["two"],
            }),
          ],
        } satisfies WorkerVNode,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      assertEquals(
        collector.getOpsOfType("create-element").some((op) =>
          "tagName" in op && op.tagName === "span"
        ),
        false,
        "same-key child update should not recreate the element",
      );
      assertEquals(
        collector.getOpsOfType("remove-node").some((op) =>
          "nodeId" in op && op.nodeId === spanNodeId
        ),
        false,
        "same-key child update should not remove the element",
      );
      assertEquals(
        collector.getOpsOfType("set-prop").some((op) =>
          "key" in op && op.key === "data-count" &&
          "value" in op && op.value === "2"
        ),
        true,
        "same-key child prop should update",
      );
      assertEquals(
        collector.getOps().some((op) =>
          (op.op === "update-text" || op.op === "create-text") &&
          "text" in op && op.text === "two"
        ),
        true,
        "same-key child text should update",
      );
    },
  );

  await t.step("replaces same-key child when tag changes", async () => {
    const collector = createOpsCollector();
    const reconciler = new WorkerReconciler({
      onOps: collector.onOps,
    });

    const rootCell = new MockCell(
      {
        type: "vnode",
        name: "div",
        props: {},
        children: [{
          type: "vnode",
          name: "span",
          props: { key: "stable" },
          children: ["old"],
        }],
      } satisfies WorkerVNode,
    );

    reconciler.mount(unknownCell(rootCell));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const spanCreate = collector.getOpsOfType("create-element").find((op) =>
      "tagName" in op && op.tagName === "span"
    );
    if (!spanCreate || !("nodeId" in spanCreate)) {
      throw new Error("Expected initial keyed span");
    }
    const spanNodeId = spanCreate.nodeId;
    collector.clear();

    rootCell.set(
      {
        type: "vnode",
        name: "div",
        props: {},
        children: [{
          type: "vnode",
          name: "button",
          props: { key: "stable" },
          children: ["new"],
        }],
      } satisfies WorkerVNode,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    assertEquals(
      collector.getOpsOfType("remove-node").some((op) =>
        "nodeId" in op && op.nodeId === spanNodeId
      ),
      true,
      "same-key tag change should remove the old child",
    );
    assertEquals(
      collector.getOpsOfType("create-element").some((op) =>
        "tagName" in op && op.tagName === "button"
      ),
      true,
      "same-key tag change should create the replacement child",
    );
  });
});
