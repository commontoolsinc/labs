import { assertEquals } from "@std/assert";
import { WorkerReconciler } from "../src/worker/reconciler.ts";
import type { VDomOp } from "../src/vdom-ops.ts";
import { provideElementSpace } from "../src/main/space-context.ts";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "@commonfabric/runner";
import type { Cell } from "@commonfabric/runner";
import type { WorkerVNode } from "../src/worker/types.ts";

type CreateElementOp = Extract<VDomOp, { op: "create-element" }>;
type RuntimeCellConstructor = new (...args: unknown[]) => object;

// Space stamping (seefeldb's #4074 design): each create-element op
// carries the space of the cell whose render produced it, elided when
// the nearest stamped ancestor's space is the same — so cross-space
// TRANSCLUSION re-stamps at its boundary and everything else inherits.

function createOpsCollector() {
  const allOps: VDomOp[] = [];
  return {
    onOps: (ops: VDomOp[]) => allOps.push(...ops),
    creates: () =>
      allOps.filter((op): op is CreateElementOp => op.op === "create-element"),
  };
}

Deno.test("worker reconciler - space stamping across transclusion", async (t) => {
  const signer = await Identity.fromPassphrase("test space stamp");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://localhost"),
  });
  const dummyTx = runtime.edit();
  const dummyCell = runtime.getCell(signer.did(), "dummy", undefined, dummyTx);
  const CellImplConstructor = dummyCell.constructor;
  const MockCellBase = CellImplConstructor as unknown as RuntimeCellConstructor;

  class MockCell<T> extends MockCellBase {
    #space: string;
    constructor(public value: T, space: string) {
      super(runtime, undefined, undefined, false, undefined, "cell");
      this.value = value;
      this.#space = space;
    }
    get space() {
      return this.#space;
    }
    sink(callback: (value: T) => void) {
      callback(this.value);
      return () => {};
    }
    isStream() {
      return false;
    }
    get() {
      return this.value;
    }
    getAsNormalizedFullLink() {
      return {
        id: "of:mock",
        space: this.#space,
        path: [],
        scope: "space",
      };
    }
  }

  const spaceA = "did:key:z6Mk-stamp-outer";
  const spaceB = "did:key:z6Mk-stamp-transcluded";
  const workerVNodeCell = (cell: MockCell<WorkerVNode>): Cell<WorkerVNode> =>
    cell as unknown as Cell<WorkerVNode>;

  await t.step(
    "root stamps; same-space child elides; transcluded subtree re-stamps",
    async () => {
      const transcludedVNode: WorkerVNode = {
        type: "vnode",
        name: "span",
        props: {},
        children: ["inner"],
      };
      const transcluded = new MockCell(
        transcludedVNode,
        spaceB,
      );
      const rootVNode: WorkerVNode = {
        type: "vnode",
        name: "div",
        props: {},
        children: [
          { type: "vnode", name: "p", props: {}, children: ["same"] },
          workerVNodeCell(transcluded),
        ],
      };
      const root = new MockCell(
        rootVNode,
        spaceA,
      );
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({ onOps: collector.onOps });
      const cancel = reconciler.mount(workerVNodeCell(root));
      await new Promise((resolve) => setTimeout(resolve, 0)); // op flush
      const byTag = Object.fromEntries(
        collector.creates().map((op) => [op.tagName, op.space]),
      );
      // Root element carries the mounting cell's space.
      assertEquals(byTag["div"], spaceA);
      // Same-space child inherits (elided).
      assertEquals(byTag["p"], undefined);
      // The transcluded cell's subtree re-stamps with ITS space.
      assertEquals(byTag["span"], spaceB);
      cancel();
    },
  );

  await t.step("static mounts carry no space", async () => {
    const collector = createOpsCollector();
    const reconciler = new WorkerReconciler({ onOps: collector.onOps });
    const staticRoot: WorkerVNode = {
      type: "vnode",
      name: "div",
      props: {},
      children: [],
    };
    const cancel = reconciler.mount(staticRoot);
    await new Promise((resolve) => setTimeout(resolve, 0)); // op flush
    assertEquals(collector.creates()[0].space, undefined);
    cancel();
  });

  await runtime.dispose();
  await storageManager.close();
});

Deno.test("provideElementSpace answers the context protocol for 'space'", () => {
  const target = new EventTarget();
  provideElementSpace(target, "did:key:z6Mk-ctx");
  let received: string | undefined;
  let stopped = false;
  const event = Object.assign(
    new Event("context-request", { bubbles: true }),
    {
      context: "space",
      callback: (value: string | undefined) => {
        received = value;
      },
    },
  );
  const origStop = event.stopPropagation.bind(event);
  event.stopPropagation = () => {
    stopped = true;
    origStop();
  };
  target.dispatchEvent(event);
  assertEquals(received, "did:key:z6Mk-ctx");
  assertEquals(stopped, true);

  // Other contexts pass through untouched.
  let otherAnswered = false;
  const other = Object.assign(new Event("context-request"), {
    context: "runtime",
    callback: () => {
      otherAnswered = true;
    },
  });
  target.dispatchEvent(other);
  assertEquals(otherAnswered, false);
});
