import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { type Cell, Runtime, type VNode } from "@commonfabric/runner";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { WorkerReconciler } from "../src/worker/reconciler.ts";
import { opsFlushed } from "./reconciler-support.ts";

type SyncCall = {
  id: string;
  path: string[];
};

async function renderAndCollectSyncs(vnode: VNode): Promise<SyncCall[]> {
  const signer = await Identity.fromPassphrase(
    "worker reconciler sync regression",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const syncCalls: SyncCall[] = [];
  const originalSyncCell = storageManager.syncCell.bind(storageManager);
  storageManager.syncCell = async function <T>(
    cell: Cell<T>,
  ): Promise<Cell<T>> {
    const { id, path } = cell.getAsNormalizedFullLink();
    syncCalls.push({ id, path: path.map(String) });
    return await originalSyncCell(cell);
  };

  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://localhost"),
  });
  const tx = runtime.edit();
  const rootCell = runtime.getCell<VNode>(
    signer.did(),
    "worker-reconciler-sync-root",
    undefined,
    tx,
  );
  rootCell.set(vnode);
  await tx.commit();
  syncCalls.length = 0;

  const reconciler = new WorkerReconciler({ onOps: () => {} });
  const cancel = reconciler.mount(
    rootCell.asSchema(rendererVDOMSchema) as Cell<never>,
  );
  try {
    await opsFlushed(runtime);
    return syncCalls;
  } finally {
    cancel();
    await runtime.dispose();
  }
}

Deno.test("worker reconciler preserves sync state across VDOM asCell cuts", async () => {
  const syncCalls = await renderAndCollectSyncs({
    type: "vnode",
    name: "main",
    props: {},
    children: [{
      type: "vnode",
      name: "section",
      props: {},
      children: [{
        type: "vnode",
        name: "span",
        props: {},
        children: ["leaf"],
      }],
    }],
  });

  assertEquals(
    syncCalls.length,
    1,
    `Expected only the mounted root to sync, got ${JSON.stringify(syncCalls)}`,
  );
  assertEquals(syncCalls[0]?.path, []);
});
