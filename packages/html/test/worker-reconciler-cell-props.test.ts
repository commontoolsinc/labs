import { assert, assertEquals } from "@std/assert";
import { WorkerReconciler } from "../src/worker/reconciler.ts";
import type { WorkerVNode } from "../src/worker/types.ts";

import type { VDomOp } from "../src/vdom-ops.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { isCfcEventEnvelope, Runtime, UI } from "@commontools/runner";
import type { NormalizedLink } from "@commontools/runner";
import { cfcLabelsAddress } from "../../runner/src/cfc/shared.ts";

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

    constructor(public value: any, link?: NormalizedLink) {
      super(runtime, undefined, link, false, undefined, "cell");
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
          new MockPropCell(this.value?.[propName], this, propName),
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
    private parentCell?: MockPropsCell;
    private propKey?: string;

    constructor(value: any, parentCell?: MockPropsCell, propKey?: string) {
      super(value);
      this.parentCell = parentCell;
      this.propKey = propKey;
    }

    asSchema(_schema: any) {
      return this;
    }

    resolveAsCell() {
      // Read live value from parent (matches real Cell.key().resolveAsCell()
      // which navigates the live data, not a stale cache)
      const liveValue = this.parentCell
        ? this.parentCell.value?.[this.propKey!]
        : this.value;
      if (
        liveValue && typeof liveValue === "object" && "sink" in liveValue
      ) {
        return liveValue;
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

    constructor(link?: NormalizedLink) {
      super(undefined, link);
    }

    override isStream() {
      return true;
    }

    send(event: unknown) {
      this.sent.push(event);
    }
  }

  function isUiAtom(
    value: unknown,
  ): value is {
    type: string;
    surface?: string;
    slot?: string;
    action?: string;
    role?: string;
    kind?: string;
  } {
    return typeof value === "object" && value !== null && "type" in value;
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
      const renderErrors: Error[] = [];
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
        onError: (error) => renderErrors.push(error),
        runtime,
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

  await t.step(
    "Cell<Props> props cleared then re-emitted re-registers handlers",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const mockStream = new MockStream();
      const propsCell = new MockPropsCell({
        className: "foo",
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

      const initialEvents = collector.getOpsOfType("set-event");
      assertEquals(initialEvents.length >= 1, true, "Initial set-event");
      const initialProps = collector.getOpsOfType("set-prop");
      assertEquals(
        initialProps.some((op: any) => op.key === "className"),
        true,
        "Initial className",
      );
      collector.clear();

      // Clear all props
      propsCell.set(null);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const removeOps = collector.getOps();
      assertEquals(removeOps.length > 0, true, "Should emit removal ops");
      collector.clear();

      // Re-emit the same props — handlers must be re-registered
      propsCell.set({ className: "foo", onclick: mockStream });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const reEvents = collector.getOpsOfType("set-event");
      assertEquals(
        reEvents.length >= 1,
        true,
        "Must re-register event handler after props were cleared",
      );

      const reProps = collector.getOpsOfType("set-prop");
      assertEquals(
        reProps.some((op: any) => op.key === "className"),
        true,
        "Must re-set className after props were cleared",
      );
    },
  );

  await t.step(
    "Cell<Props> unchanged primitive props are not re-emitted",
    async () => {
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

      // Re-emit identical values
      propsCell.set({ className: "foo", title: "bar" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const setPropOps = collector.getOpsOfType("set-prop");
      assertEquals(
        setPropOps.length,
        0,
        "Should emit NO set-prop ops when primitive values are unchanged",
      );

      collector.clear();

      // Change only one value
      propsCell.set({ className: "foo", title: "baz" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const updatedOps = collector.getOpsOfType("set-prop");
      assertEquals(
        updatedOps.length,
        1,
        "Should emit exactly one set-prop for the changed value",
      );
      assertEquals(
        (updatedOps[0] as any).key,
        "title",
        "Changed prop should be title",
      );
      assertEquals((updatedOps[0] as any).value, "baz");
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

  await t.step(
    "cell-backed stream event props mint integrity from same-tree UI provenance",
    async () => {
      const collector = createOpsCollector();
      const renderErrors: Error[] = [];
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
        onError: (error) => renderErrors.push(error),
        runtime,
      });

      const actionAtom = {
        type: "https://commonfabric.org/cfc/atom/UiActionContract",
        action: "SubmitDirectCommand",
      } as const;

      const clickStream = new MockStream({
        space: signer.did(),
        id: "of:ui-direct-command-stream",
        type: "application/json",
        path: [],
      });
      (clickStream as unknown as { runtime?: Runtime }).runtime = undefined;
      const handlerCell = new MockCell(clickStream);
      const rootCell = new MockCell({
        [UI]: {
          type: "vnode",
          name: "ct-vstack",
          props: {},
          children: [{
            type: "vnode",
            name: "ct-button",
            props: {
              "data-ui-action": "SubmitDirectCommand",
              onClick: handlerCell,
            },
            children: ["Submit direct command"],
          }],
        },
      }, {
        space: signer.did(),
        id: "of:ui-direct-command-piece",
        type: "application/json",
        path: [],
        schema: {
          type: "object",
          properties: {
            [UI]: {
              type: "object",
              properties: {
                children: {
                  type: "array",
                  prefixItems: [{
                    type: "object",
                    ifc: {
                      addIntegrity: [actionAtom],
                    },
                    properties: {
                      props: {
                        type: "object",
                        properties: {
                          "data-ui-action": { type: "string" },
                        },
                      },
                    },
                  }],
                },
              },
            },
          },
          required: [UI],
        },
      });

      reconciler.mount(rootCell as any);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const setEventOps = collector.getOpsOfType("set-event");
      assertEquals(
        setEventOps.length >= 1,
        true,
        "Should register click handler",
      );

      const clickHandlerId =
        (setEventOps[0] as { handlerId: number }).handlerId;
      reconciler.dispatchEvent(clickHandlerId, {
        type: "click",
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      if (renderErrors.length > 0) {
        throw renderErrors[0];
      }
      assertEquals(clickStream.sent.length, 1);
      const envelope = clickStream.sent[0];
      assert(isCfcEventEnvelope(envelope));
      assertEquals(
        envelope.integrity.some((atom) =>
          isUiAtom(atom) &&
          atom.type === actionAtom.type &&
          atom.action === actionAtom.action
        ),
        true,
      );
    },
  );

  await t.step(
    "cell-backed stream event props derive prompt-slot and disclosure integrity from same-tree UI context",
    async () => {
      const collector = createOpsCollector();
      const renderErrors: Error[] = [];
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
        onError: (error) => renderErrors.push(error),
        runtime,
      });

      const actionAtom = {
        type: "https://commonfabric.org/cfc/atom/UiActionContract",
        action: "SubmitDirectCommand",
      } as const;
      const promptSlotBoundAtom = {
        type: "https://commonfabric.org/cfc/atom/PromptSlotBound",
        surface: "AssistantComposer",
        role: "direct-command",
      } as const;
      const disclosureRenderedAtom = {
        type: "https://commonfabric.org/cfc/atom/DisclosureRendered",
        kind: "DirectCommandMayTriggerTools",
      } as const;

      const clickStream = new MockStream({
        space: signer.did(),
        id: "of:ui-direct-command-context-stream",
        type: "application/json",
        path: [],
      });
      (clickStream as unknown as { runtime?: Runtime }).runtime = undefined;
      const handlerCell = new MockCell(clickStream);
      const rootCell = new MockCell({
        [UI]: {
          type: "vnode",
          name: "ct-vstack",
          props: {},
          children: [
            {
              type: "vnode",
              name: "ct-card",
              props: {
                "data-ui-disclosure-kind": "DirectCommandMayTriggerTools",
              },
              children: ["Disclosure"],
            },
            {
              type: "vnode",
              name: "ct-textarea",
              props: {
                "data-ui-role": "direct-command",
                "data-ui-surface": "AssistantComposer",
              },
              children: [],
            },
            {
              type: "vnode",
              name: "ct-button",
              props: {
                "data-ui-action": "SubmitDirectCommand",
                onClick: handlerCell,
              },
              children: ["Submit direct command"],
            },
          ],
        },
      }, {
        space: signer.did(),
        id: "of:ui-direct-command-context-piece",
        type: "application/json",
        path: [],
        schema: {
          type: "object",
          properties: {
            [UI]: {
              type: "object",
              properties: {
                children: {
                  type: "array",
                  prefixItems: [
                    {
                      type: "object",
                      ifc: {
                        addIntegrity: [{
                          type: "https://commonfabric.org/cfc/atom/UiDisclosureContract",
                          kind: "DirectCommandMayTriggerTools",
                        }],
                      },
                    },
                    {
                      type: "object",
                      ifc: {
                        addIntegrity: [{
                          type: "https://commonfabric.org/cfc/atom/UiPromptSlotContract",
                          surface: "AssistantComposer",
                          role: "direct-command",
                        }],
                      },
                    },
                    {
                      type: "object",
                      ifc: {
                        addIntegrity: [actionAtom],
                      },
                      properties: {
                        props: {
                          type: "object",
                          properties: {
                            "data-ui-action": { type: "string" },
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          required: [UI],
        },
      });

      reconciler.mount(rootCell as any);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const setEventOps = collector.getOpsOfType("set-event");
      assertEquals(
        setEventOps.length >= 1,
        true,
        "Should register click handler",
      );

      const clickHandlerId =
        (setEventOps[0] as { handlerId: number }).handlerId;
      reconciler.dispatchEvent(clickHandlerId, {
        type: "click",
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      if (renderErrors.length > 0) {
        throw renderErrors[0];
      }
      assertEquals(clickStream.sent.length, 1);
      const envelope = clickStream.sent[0];
      assert(isCfcEventEnvelope(envelope));
      assertEquals(
        envelope.integrity.some((atom) =>
          isUiAtom(atom) &&
          atom.type === actionAtom.type &&
          atom.action === actionAtom.action
        ),
        true,
      );
      assertEquals(
        envelope.integrity.some((atom) =>
          isUiAtom(atom) &&
          atom.type === promptSlotBoundAtom.type &&
          atom.surface === promptSlotBoundAtom.surface &&
          atom.role === promptSlotBoundAtom.role
        ),
        true,
      );
      assertEquals(
        envelope.integrity.some((atom) =>
          isUiAtom(atom) &&
          atom.type === disclosureRenderedAtom.type &&
          atom.kind === disclosureRenderedAtom.kind
        ),
        true,
      );
    },
  );

  await t.step(
    "stream events mint integrity from parent and child UI provenance",
    async () => {
      const collector = createOpsCollector();
      const renderErrors: Error[] = [];
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
        onError: (error) => renderErrors.push(error),
      });

      const placementAtom = {
        type: "https://commonfabric.org/cfc/atom/UiPlacement",
        surface: "InboxList",
        slot: "message-row",
      } as const;
      const actionAtom = {
        type: "https://commonfabric.org/cfc/atom/UiActionContract",
        action: "ShareReviewedMessage",
      } as const;

      const tx = runtime.edit();
      const parentResult = runtime.getCell(
        signer.did(),
        "ui-parent-provenance-test",
        undefined,
        tx,
      );
      const childResult = runtime.getCell(
        signer.did(),
        "ui-child-provenance-test",
        undefined,
        tx,
      );
      const mockStream = new MockStream({
        space: signer.did(),
        id: "of:ui-child-provenance-click-stream",
        type: "application/json",
        path: [],
      });

      parentResult.set({});
      childResult.set({});

      tx.writeOrThrow(
        cfcLabelsAddress(parentResult.getAsNormalizedFullLink()),
        {
          "/$UI/children/0": {
            shape: {
              integrity: [placementAtom],
            },
          },
        },
      );

      tx.writeOrThrow(cfcLabelsAddress(childResult.getAsNormalizedFullLink()), {
        "/$UI": {
          shape: {
            integrity: [actionAtom],
          },
        },
      });

      const committed = await tx.commit();
      assertEquals(committed.error, undefined);

      const parentLink = parentResult.getAsNormalizedFullLink();
      const childLink = childResult.getAsNormalizedFullLink();
      const linkedChildCell = new MockCell({
        [UI]: {
          type: "vnode",
          name: "ct-button",
          props: {
            "data-ui-action": "ShareReviewedMessage",
            onClick: mockStream,
          },
          children: ["Share"],
        },
      }, {
        space: childLink.space,
        id: childLink.id,
        type: childLink.type,
        path: [],
      });
      const rootUiCell = new MockCell({
        type: "vnode",
        name: "ct-vstack",
        props: {},
        children: [linkedChildCell],
      }, {
        space: parentLink.space,
        id: parentLink.id,
        type: parentLink.type,
        path: [UI],
      });
      reconciler.mount(rootUiCell as any);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const setEventOps = collector.getOpsOfType("set-event");
      assertEquals(
        setEventOps.length >= 1,
        true,
        "Should register click handler",
      );

      const clickHandlerId =
        (setEventOps[0] as { handlerId: number }).handlerId;
      reconciler.dispatchEvent(clickHandlerId, {
        type: "click",
        target: {
          dataset: {
            uiAction: "ShareReviewedMessage",
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      if (renderErrors.length > 0) {
        throw renderErrors[0];
      }
      assertEquals(mockStream.sent.length, 1);
      const envelope = mockStream.sent[0];
      assert(isCfcEventEnvelope(envelope));
      assertEquals(
        envelope.integrity.some((atom) =>
          isUiAtom(atom) &&
          atom.type === placementAtom.type &&
          atom.surface === placementAtom.surface &&
          atom.slot === placementAtom.slot
        ),
        true,
      );
      assertEquals(
        envelope.integrity.some((atom) =>
          isUiAtom(atom) &&
          atom.type === actionAtom.type &&
          atom.action === actionAtom.action
        ),
        true,
      );
    },
  );
});
