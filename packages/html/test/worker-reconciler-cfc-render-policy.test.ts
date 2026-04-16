import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { isCell as isRuntimeCell, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { WorkerVNode } from "../src/worker/types.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";
import type { VDomOp } from "../src/vdom-ops.ts";

function createOpsCollector() {
  const allOps: VDomOp[] = [];
  return {
    onOps: (ops: VDomOp[]) => allOps.push(...ops),
    clear: () => {
      allOps.length = 0;
    },
    getOpsOfType: <Type extends VDomOp["op"]>(opType: Type) =>
      allOps.filter((op): op is Extract<VDomOp, { op: Type }> =>
        op.op === opType
      ),
  };
}

Deno.test("worker reconciler CFC render policy", async (t) => {
  const signer = await Identity.fromPassphrase(
    "worker reconciler cfc render policy",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://localhost"),
  });
  const healthRecordAtom = {
    type: "https://commonfabric.org/cfc/atom/Resource",
    class: "SensitiveHealthRecord",
    subject: signer.did(),
  };
  const healthClinicAtom = {
    type: "https://commonfabric.org/cfc/atom/Origin",
    uri: "https://health-clinic.example/records",
    fetchedAt: 0,
  };
  const otherClinicAtom = {
    type: "https://commonfabric.org/cfc/atom/Origin",
    uri: "https://other-system.example/records",
    fetchedAt: 0,
  };

  try {
    const tx = runtime.edit();
    const secret = runtime.getCell<string>(
      signer.did(),
      "cfc-render-policy-secret",
      undefined,
      tx,
    );
    const secretLink = secret.getAsNormalizedFullLink();
    tx.writeOrThrow({
      space: signer.did(),
      id: secretLink.id!,
      type: "application/json",
      path: [],
    }, {
      value: "Sensitive diagnosis: migraine",
      cfc: {
        version: 1,
        schemaHash: "test-schema",
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            label: { confidentiality: [healthRecordAtom] },
          }],
        },
      },
    });
    const structuredSecret = runtime.getCell<string>(
      signer.did(),
      "cfc-render-policy-structured-secret",
      undefined,
      tx,
    );
    const structuredSecretLink = structuredSecret.getAsNormalizedFullLink();
    tx.writeOrThrow({
      space: signer.did(),
      id: structuredSecretLink.id!,
      type: "application/json",
      path: [],
    }, {
      value: "Structured atom record",
      cfc: {
        version: 1,
        schemaHash: "test-structured-schema",
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            label: { confidentiality: [healthClinicAtom] },
          }],
        },
      },
    });
    const aliceAuthoredText = runtime.getCell<string>(
      signer.did(),
      "cfc-render-policy-alice-authored-text",
      undefined,
      tx,
    );
    const aliceAuthoredTextLink = aliceAuthoredText.getAsNormalizedFullLink();
    tx.writeOrThrow({
      space: signer.did(),
      id: aliceAuthoredTextLink.id!,
      type: "application/json",
      path: [],
    }, {
      value: "Alice signed chat text",
      cfc: {
        version: 1,
        schemaHash: "test-authored-text-schema",
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            label: {
              integrity: [{ kind: "authored-by", subject: "alice" }],
            },
          }],
        },
      },
    });
    const unsignedText = runtime.getCell<string>(
      signer.did(),
      "cfc-render-policy-unsigned-text",
      undefined,
      tx,
    );
    unsignedText.set("Unsigned chat text");
    const commitResult = await tx.commit();
    assertEquals(commitResult.ok !== undefined, true);

    const confidential = runtime.getCell<string>(
      signer.did(),
      "cfc-render-policy-secret",
    );
    const structuredClassified = runtime.getCell<string>(
      signer.did(),
      "cfc-render-policy-structured-secret",
    );
    const authoredText = runtime.getCell<string>(
      signer.did(),
      "cfc-render-policy-alice-authored-text",
    );
    const unsignedChatText = runtime.getCell<string>(
      signer.did(),
      "cfc-render-policy-unsigned-text",
    );
    const dummyTx = runtime.edit();
    const dummyCell = runtime.getCell(
      signer.did(),
      "cfc-render-policy-dummy",
      undefined,
      dummyTx,
    );
    const CellImplConstructor = dummyCell.constructor;

    class MockCell extends (CellImplConstructor as any) {
      private subscribers = new Set<(value: unknown) => void>();

      constructor(public value: unknown) {
        super(runtime, undefined, undefined, false, undefined, "cell");
      }

      sink(callback: (value: unknown) => void) {
        this.subscribers.add(callback);
        callback(this.value);
        return () => this.subscribers.delete(callback);
      }

      set(newValue: unknown) {
        this.value = newValue;
        for (const subscriber of this.subscribers) {
          subscriber(newValue);
        }
      }

      isStream() {
        return false;
      }
    }

    class MockPropsCell extends MockCell {
      private propCells = new Map<string, MockPropCell>();

      key(propName: string) {
        if (!this.propCells.has(propName)) {
          this.propCells.set(propName, new MockPropCell(this, propName));
        }
        return this.propCells.get(propName)!;
      }

      getRawUntyped() {
        return this.value;
      }

      override set(newValue: unknown) {
        super.set(newValue);
        for (const propCell of this.propCells.values()) {
          propCell.refresh();
        }
      }
    }

    class MockPropCell extends MockCell {
      constructor(private parentCell: MockPropsCell, private propKey: string) {
        super((parentCell.value as Record<string, unknown>)?.[propKey]);
      }

      asSchema(_schema: unknown) {
        return this;
      }

      resolveAsCell() {
        const liveValue = this.getRawUntyped();
        return isRuntimeCell(liveValue) ? liveValue : this;
      }

      getRawUntyped() {
        return (this.parentCell.value as Record<string, unknown> | undefined)
          ?.[this.propKey];
      }

      refresh() {
        super.set(this.getRawUntyped());
      }
    }

    await t.step(
      "blocks a confidential cell above the boundary max confidentiality",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });
        const root: WorkerVNode = {
          type: "vnode",
          name: "cf-cfc-render-boundary",
          props: { maxConfidentiality: [] },
          children: [confidential as never],
        };

        const cancel = reconciler.mount(root);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));

          const renderedText = collector.getOpsOfType("create-text")
            .map((op) => op.text);
          assertEquals(
            renderedText.includes("Sensitive diagnosis: migraine"),
            false,
          );
          assertEquals(renderedText.includes("Content hidden by policy"), true);
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "renders a confidential cell when the boundary declassifies that label",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });
        const root: WorkerVNode = {
          type: "vnode",
          name: "cf-cfc-render-boundary",
          props: {
            maxConfidentiality: [],
            declassifyConfidentiality: [healthRecordAtom],
          },
          children: [confidential as never],
        };

        const cancel = reconciler.mount(root);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));

          const renderedText = collector.getOpsOfType("create-text")
            .map((op) => op.text);
          assertEquals(
            renderedText.includes("Sensitive diagnosis: migraine"),
            true,
          );
          assertEquals(
            renderedText.includes("Content hidden by policy"),
            false,
          );
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "matches structured render-policy atoms by structural equality",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });
        const root: WorkerVNode = {
          type: "vnode",
          name: "cf-cfc-render-boundary",
          props: {
            maxConfidentiality: [healthClinicAtom],
          },
          children: [structuredClassified as never],
        };

        const cancel = reconciler.mount(root);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));

          const renderedText = collector.getOpsOfType("create-text")
            .map((op) => op.text);
          assertEquals(renderedText.includes("Structured atom record"), true);
          assertEquals(
            renderedText.includes("Content hidden by policy"),
            false,
          );
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "does not collapse distinct structured atoms through string coercion",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });
        const root: WorkerVNode = {
          type: "vnode",
          name: "cf-cfc-render-boundary",
          props: {
            maxConfidentiality: [otherClinicAtom],
          },
          children: [structuredClassified as never],
        };

        const cancel = reconciler.mount(root);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));

          const renderedText = collector.getOpsOfType("create-text")
            .map((op) => op.text);
          assertEquals(renderedText.includes("Structured atom record"), false);
          assertEquals(renderedText.includes("Content hidden by policy"), true);
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "blocks materialized children when boundary $value is confidential",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });
        const root: WorkerVNode = {
          type: "vnode",
          name: "cf-cfc-render-boundary",
          props: {
            maxConfidentiality: [],
            $value: confidential as never,
          },
          children: [{
            type: "vnode",
            name: "div",
            props: { id: "materialized-secret" },
            children: ["Sensitive diagnosis: migraine"],
          }],
        };

        const cancel = reconciler.mount(root);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));

          const renderedText = collector.getOpsOfType("create-text")
            .map((op) => op.text);
          assertEquals(
            renderedText.includes("Sensitive diagnosis: migraine"),
            false,
          );
          assertEquals(renderedText.includes("Content hidden by policy"), true);
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "blocks materialized children when boundary policy props are reactive",
      async () => {
        const propsTx = runtime.edit();
        const propsCell = runtime.getCell(
          signer.did(),
          "cfc-render-policy-boundary-props",
          undefined,
          propsTx,
        );
        propsCell.setRawUntyped({
          maxConfidentiality: [],
          $value: confidential.getAsLink({ includeSchema: true }),
        });
        const propsCommitResult = await propsTx.commit();
        assertEquals(propsCommitResult.ok !== undefined, true);

        const boundaryProps = runtime.getCell(
          signer.did(),
          "cfc-render-policy-boundary-props",
        );
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });
        const root: WorkerVNode = {
          type: "vnode",
          name: "cf-cfc-render-boundary",
          props: boundaryProps as never,
          children: [{
            type: "vnode",
            name: "div",
            props: { id: "reactive-policy-secret" },
            children: ["Sensitive diagnosis: migraine"],
          }],
        };

        const cancel = reconciler.mount(root);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));

          const renderedText = collector.getOpsOfType("create-text")
            .map((op) => op.text);
          assertEquals(
            renderedText.includes("Sensitive diagnosis: migraine"),
            false,
          );
          assertEquals(renderedText.includes("Content hidden by policy"), true);
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "renders materialized children when reactive policy props declassify",
      async () => {
        const propsTx = runtime.edit();
        const propsCell = runtime.getCell(
          signer.did(),
          "cfc-render-policy-declassify-props",
          undefined,
          propsTx,
        );
        propsCell.setRawUntyped({
          maxConfidentiality: [],
          declassifyConfidentiality: [healthRecordAtom],
          $value: confidential.getAsLink({ includeSchema: true }),
        });
        const propsCommitResult = await propsTx.commit();
        assertEquals(propsCommitResult.ok !== undefined, true);

        const boundaryProps = runtime.getCell(
          signer.did(),
          "cfc-render-policy-declassify-props",
        );
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });
        const root: WorkerVNode = {
          type: "vnode",
          name: "cf-cfc-render-boundary",
          props: boundaryProps as never,
          children: [{
            type: "vnode",
            name: "div",
            props: { id: "reactive-policy-revealed" },
            children: ["Sensitive diagnosis: migraine"],
          }],
        };

        const cancel = reconciler.mount(root);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));

          const renderedText = collector.getOpsOfType("create-text")
            .map((op) => op.text);
          assertEquals(
            renderedText.includes("Sensitive diagnosis: migraine"),
            true,
          );
          assertEquals(
            renderedText.includes("Content hidden by policy"),
            false,
          );
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "preserves an outer unlabeled-only boundary through an unbounded child boundary",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });
        const root: WorkerVNode = {
          type: "vnode",
          name: "cf-cfc-render-boundary",
          props: { maxConfidentiality: [] },
          children: [{
            type: "vnode",
            name: "cf-cfc-render-boundary",
            props: { $value: confidential },
            children: ["Sensitive diagnosis: migraine"],
          }],
        };

        const cancel = reconciler.mount(root);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));

          const renderedText = collector.getOpsOfType("create-text")
            .map((op) => op.text);
          assertEquals(
            renderedText.includes("Sensitive diagnosis: migraine"),
            false,
          );
          assertEquals(renderedText.includes("Content hidden by policy"), true);
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "reveals materialized children when boundary updates to declassify",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });
        const rootCell = new MockCell(
          {
            type: "vnode",
            name: "cf-cfc-render-boundary",
            props: {
              maxConfidentiality: [],
              $value: confidential,
            },
            children: [{
              type: "vnode",
              name: "div",
              props: { id: "initially-blocked-secret" },
              children: ["Sensitive diagnosis: migraine"],
            }],
          } satisfies WorkerVNode,
        );

        const cancel = reconciler.mount(rootCell as never);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));
          collector.clear();

          rootCell.set(
            {
              type: "vnode",
              name: "cf-cfc-render-boundary",
              props: {
                maxConfidentiality: [],
                declassifyConfidentiality: [healthRecordAtom],
                $value: confidential,
              },
              children: [{
                type: "vnode",
                name: "div",
                props: { id: "revealed-secret" },
                children: ["Sensitive diagnosis: migraine"],
              }],
            } satisfies WorkerVNode,
          );
          await new Promise((resolve) => setTimeout(resolve, 10));

          const renderedText = collector.getOpsOfType("create-text")
            .map((op) => op.text);
          assertEquals(
            renderedText.includes("Sensitive diagnosis: migraine"),
            true,
          );
          assertEquals(
            renderedText.includes("Content hidden by policy"),
            false,
          );
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "blocks cell children when boundary tightens to unlabeled-only",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });
        const rootCell = new MockCell(
          {
            type: "vnode",
            name: "cf-cfc-render-boundary",
            props: {},
            children: [confidential as never],
          } satisfies WorkerVNode,
        );

        const cancel = reconciler.mount(rootCell as never);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));
          let renderedText = collector.getOpsOfType("create-text")
            .map((op) => op.text);
          assertEquals(
            renderedText.includes("Sensitive diagnosis: migraine"),
            true,
          );
          collector.clear();

          rootCell.set(
            {
              type: "vnode",
              name: "cf-cfc-render-boundary",
              props: { maxConfidentiality: [] },
              children: [confidential as never],
            } satisfies WorkerVNode,
          );
          await new Promise((resolve) => setTimeout(resolve, 10));

          renderedText = collector.getOpsOfType("create-text")
            .map((op) => op.text);
          assertEquals(
            renderedText.includes("Sensitive diagnosis: migraine"),
            false,
          );
          assertEquals(renderedText.includes("Content hidden by policy"), true);
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "reveals materialized children when reactive policy props update",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });
        const propsCell = new MockPropsCell({
          maxConfidentiality: [],
          $value: confidential,
        });
        const root: WorkerVNode = {
          type: "vnode",
          name: "cf-cfc-render-boundary",
          props: propsCell as never,
          children: [{
            type: "vnode",
            name: "div",
            props: { id: "reactive-props-updated-secret" },
            children: ["Sensitive diagnosis: migraine"],
          }],
        };

        const cancel = reconciler.mount(root);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));
          collector.clear();

          propsCell.set({
            maxConfidentiality: [],
            declassifyConfidentiality: [healthRecordAtom],
            $value: confidential,
          });
          await new Promise((resolve) => setTimeout(resolve, 10));

          const renderedText = collector.getOpsOfType("create-text")
            .map((op) => op.text);
          assertEquals(
            renderedText.includes("Sensitive diagnosis: migraine"),
            true,
          );
          assertEquals(
            renderedText.includes("Content hidden by policy"),
            false,
          );
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "strict authorship renders child text with matching integrity",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });
        const root: WorkerVNode = {
          type: "vnode",
          name: "cf-cfc-authorship",
          props: {
            author: "alice",
            verifyTextIntegrity: true,
          },
          children: [authoredText as never],
        };

        const cancel = reconciler.mount(root);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));

          const renderedText = collector.getOpsOfType("create-text")
            .map((op) => op.text);
          assertEquals(renderedText.includes("Alice signed chat text"), true);
          assertEquals(
            renderedText.includes("Content hidden by integrity policy"),
            false,
          );
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "strict authorship blocks child text with mismatched integrity",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });
        const root: WorkerVNode = {
          type: "vnode",
          name: "cf-cfc-authorship",
          props: {
            author: "bob",
            verifyTextIntegrity: true,
          },
          children: [authoredText as never],
        };

        const cancel = reconciler.mount(root);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));

          const renderedText = collector.getOpsOfType("create-text")
            .map((op) => op.text);
          assertEquals(renderedText.includes("Alice signed chat text"), false);
          assertEquals(
            renderedText.includes("Content hidden by integrity policy"),
            true,
          );
          assertEquals(
            collector.getOpsOfType("set-prop").some((op) =>
              op.key === "textIntegrityState" && op.value === "blocked"
            ),
            true,
          );
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "strict authorship blocks unsigned child text",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });
        const root: WorkerVNode = {
          type: "vnode",
          name: "cf-cfc-authorship",
          props: {
            author: "alice",
            verifyTextIntegrity: true,
          },
          children: [unsignedChatText as never],
        };

        const cancel = reconciler.mount(root);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));

          const renderedText = collector.getOpsOfType("create-text")
            .map((op) => op.text);
          assertEquals(renderedText.includes("Unsigned chat text"), false);
          assertEquals(
            renderedText.includes("Content hidden by integrity policy"),
            true,
          );
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "strict authorship blocks literal child text by default",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });
        const root: WorkerVNode = {
          type: "vnode",
          name: "cf-cfc-authorship",
          props: {
            author: "alice",
            verifyTextIntegrity: true,
          },
          children: ["Untrusted literal text"],
        };

        const cancel = reconciler.mount(root);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));

          const renderedText = collector.getOpsOfType("create-text")
            .map((op) => op.text);
          assertEquals(renderedText.includes("Untrusted literal text"), false);
          assertEquals(
            renderedText.includes("Content hidden by integrity policy"),
            true,
          );
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "strict authorship allows literal child text only with an escape hatch",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });
        const root: WorkerVNode = {
          type: "vnode",
          name: "cf-cfc-authorship",
          props: {
            author: "alice",
            verifyTextIntegrity: true,
            allowLiteralText: true,
          },
          children: ["Trusted literal chrome"],
        };

        const cancel = reconciler.mount(root);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));

          const renderedText = collector.getOpsOfType("create-text")
            .map((op) => op.text);
          assertEquals(renderedText.includes("Trusted literal chrome"), true);
          assertEquals(
            renderedText.includes("Content hidden by integrity policy"),
            false,
          );
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "strict authorship allows matching cf-chat-message content props",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });
        const root: WorkerVNode = {
          type: "vnode",
          name: "cf-cfc-authorship",
          props: {
            author: "alice",
            verifyTextIntegrity: true,
          },
          children: [{
            type: "vnode",
            name: "cf-chat-message",
            props: {
              role: "assistant",
              content: authoredText as never,
            },
            children: [],
          }],
        };

        const cancel = reconciler.mount(root);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));

          const setPropOps = collector.getOpsOfType("set-prop");
          assertEquals(
            setPropOps.some((op) =>
              op.key === "content" && op.value === "Alice signed chat text"
            ),
            true,
          );
          assertEquals(
            setPropOps.some((op) =>
              op.key === "role" && op.value === "assistant"
            ),
            true,
          );
          assertEquals(
            setPropOps.some((op) =>
              op.key === "content" &&
              op.value === "Content hidden by integrity policy"
            ),
            false,
          );
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "strict authorship blocks static cf-chat-message content props",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });
        const root: WorkerVNode = {
          type: "vnode",
          name: "cf-cfc-authorship",
          props: {
            author: "alice",
            verifyTextIntegrity: true,
          },
          children: [{
            type: "vnode",
            name: "cf-chat-message",
            props: {
              role: "assistant",
              content: "Mallory static override",
            },
            children: [],
          }],
        };

        const cancel = reconciler.mount(root);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));

          const setPropOps = collector.getOpsOfType("set-prop");
          assertEquals(
            setPropOps.some((op) =>
              op.key === "content" &&
              op.value === "Content hidden by integrity policy"
            ),
            true,
          );
          assertEquals(
            setPropOps.some((op) =>
              op.key === "data-cfc-blocked-props" &&
              op.value === "content"
            ),
            true,
          );
          assertEquals(
            setPropOps.some((op) =>
              op.key === "role" && op.value === "assistant"
            ),
            true,
          );
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "strict authorship blocks mismatched cf-chat-message name props",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });
        const root: WorkerVNode = {
          type: "vnode",
          name: "cf-cfc-authorship",
          props: {
            author: "bob",
            verifyTextIntegrity: true,
          },
          children: [{
            type: "vnode",
            name: "cf-chat-message",
            props: {
              role: "assistant",
              name: authoredText as never,
            },
            children: [],
          }],
        };

        const cancel = reconciler.mount(root);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));

          const setPropOps = collector.getOpsOfType("set-prop");
          assertEquals(
            setPropOps.some((op) =>
              op.key === "name" &&
              op.value === "Content hidden by integrity policy"
            ),
            true,
          );
          assertEquals(
            setPropOps.some((op) =>
              op.key === "textIntegrityState" && op.value === "blocked"
            ),
            true,
          );
        } finally {
          cancel();
        }
      },
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
