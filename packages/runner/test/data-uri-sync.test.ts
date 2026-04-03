import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createDataCellURI } from "../src/link-utils.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("data URI sync", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("sync on a data: URI cell with no links resolves without error", async () => {
    const dataURI = createDataCellURI({ simple: "value" });
    const cell = runtime.getCellFromEntityId(
      space,
      dataURI,
      [],
      undefined,
      tx,
    );
    const result = await cell.sync();
    expect(result).toBeDefined();
  });

  it("sync on a data: URI cell containing a sigil link calls sync on the linked cell", async () => {
    // Create a real cell that we expect to be synced
    const linkedCell = runtime.getCell(space, "linked-target", undefined, tx);
    linkedCell.set({ value: "target data" });
    const linkedId = linkedCell.getAsNormalizedFullLink().id;

    // Build a sigil link pointing at the real cell
    const sigilLink = {
      "/": {
        [LINK_V1_TAG]: {
          id: linkedId,
          path: [],
        },
      },
    };

    // Create a data: URI whose value contains that link
    const dataURI = createDataCellURI({ ref: sigilLink });
    const dataCell = runtime.getCellFromEntityId(
      space,
      dataURI,
      [],
      undefined,
      tx,
    );

    // Spy on the storage provider's sync method
    const provider = storageManager.open(space);
    const originalSync = provider.sync.bind(provider);
    const syncedIds: string[] = [];
    provider.sync = (id: any, selector?: any) => {
      syncedIds.push(id);
      return originalSync(id, selector);
    };

    await dataCell.sync();

    // The linked cell's id should have been synced
    expect(syncedIds).toContain(linkedId);
  });

  it("sync on a data: URI cell with multiple links syncs all of them", async () => {
    const cell1 = runtime.getCell(space, "multi-1", undefined, tx);
    cell1.set("first");
    const cell2 = runtime.getCell(space, "multi-2", undefined, tx);
    cell2.set("second");

    const id1 = cell1.getAsNormalizedFullLink().id;
    const id2 = cell2.getAsNormalizedFullLink().id;

    const dataURI = createDataCellURI({
      a: {
        "/": {
          [LINK_V1_TAG]: { id: id1, path: [] },
        },
      },
      b: {
        "/": {
          [LINK_V1_TAG]: { id: id2, path: [] },
        },
      },
    });

    const dataCell = runtime.getCellFromEntityId(
      space,
      dataURI,
      [],
      undefined,
      tx,
    );

    const provider = storageManager.open(space);
    const originalSync = provider.sync.bind(provider);
    const syncedIds: string[] = [];
    provider.sync = (id: any, selector?: any) => {
      syncedIds.push(id);
      return originalSync(id, selector);
    };

    await dataCell.sync();

    expect(syncedIds).toContain(id1);
    expect(syncedIds).toContain(id2);
  });

  it("sync on a data: URI cell with links in arrays syncs them", async () => {
    const cell1 = runtime.getCell(space, "arr-1", undefined, tx);
    cell1.set("item1");
    const cell2 = runtime.getCell(space, "arr-2", undefined, tx);
    cell2.set("item2");

    const id1 = cell1.getAsNormalizedFullLink().id;
    const id2 = cell2.getAsNormalizedFullLink().id;

    const dataURI = createDataCellURI([
      { "/": { [LINK_V1_TAG]: { id: id1, path: [] } } },
      { "/": { [LINK_V1_TAG]: { id: id2, path: [] } } },
    ]);

    const dataCell = runtime.getCellFromEntityId(
      space,
      dataURI,
      [],
      undefined,
      tx,
    );

    const provider = storageManager.open(space);
    const originalSync = provider.sync.bind(provider);
    const syncedIds: string[] = [];
    provider.sync = (id: any, selector?: any) => {
      syncedIds.push(id);
      return originalSync(id, selector);
    };

    await dataCell.sync();

    expect(syncedIds).toContain(id1);
    expect(syncedIds).toContain(id2);
  });

  it("sync on a data: URI cell with no links does not call provider.sync", async () => {
    const dataURI = createDataCellURI({ plain: "data", count: 42 });
    const dataCell = runtime.getCellFromEntityId(
      space,
      dataURI,
      [],
      undefined,
      tx,
    );

    const provider = storageManager.open(space);
    const originalSync = provider.sync.bind(provider);
    const syncedIds: string[] = [];
    provider.sync = (id: any, selector?: any) => {
      syncedIds.push(id);
      return originalSync(id, selector);
    };

    await dataCell.sync();

    expect(syncedIds).toEqual([]);
  });

  it("sync uses cache — repeated calls share the same promise", async () => {
    const linkedCell = runtime.getCell(space, "cache-target", undefined, tx);
    linkedCell.set("cached");
    const linkedId = linkedCell.getAsNormalizedFullLink().id;

    const dataURI = createDataCellURI({
      ref: { "/": { [LINK_V1_TAG]: { id: linkedId, path: [] } } },
    });

    const dataCell = runtime.getCellFromEntityId(
      space,
      dataURI,
      [],
      undefined,
      tx,
    );

    const provider = storageManager.open(space);
    const originalSync = provider.sync.bind(provider);
    let syncCount = 0;
    provider.sync = (id: any, selector?: any) => {
      syncCount++;
      return originalSync(id, selector);
    };

    // Call sync twice concurrently — the cache should deduplicate
    const [r1, r2] = await Promise.all([dataCell.sync(), dataCell.sync()]);
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();

    // The linked cell should have been synced at most once
    expect(syncCount).toBeLessThanOrEqual(1);
  });

  it("sync on a data: URI cell with nested data: URI links does not crash", async () => {
    // A data URI containing another data URI link — the inner data: link
    // should be skipped (not synced as a storage cell)
    const innerDataURI = createDataCellURI("inner");
    const dataURI = createDataCellURI({
      nested: { "/": { [LINK_V1_TAG]: { id: innerDataURI, path: [] } } },
    });

    const dataCell = runtime.getCellFromEntityId(
      space,
      dataURI,
      [],
      undefined,
      tx,
    );

    // Should resolve without throwing
    const result = await dataCell.sync();
    expect(result).toBeDefined();
  });

  it("sync walks into the cell path before scanning for links", async () => {
    const linkedCell = runtime.getCell(space, "deep-target", undefined, tx);
    linkedCell.set("deep");
    const linkedId = linkedCell.getAsNormalizedFullLink().id;

    // The link is nested under "level1" > "level2"
    const dataURI = createDataCellURI({
      level1: {
        level2: {
          ref: {
            "/": { [LINK_V1_TAG]: { id: linkedId, path: [] } },
          },
        },
      },
    });

    // Cell with path ["level1", "level2"] — sync should walk into the
    // value at that path and find the link there
    const dataCell = runtime.getCellFromEntityId(
      space,
      dataURI,
      ["level1", "level2"],
      undefined,
      tx,
    );

    const provider = storageManager.open(space);
    const originalSync = provider.sync.bind(provider);
    const syncedIds: string[] = [];
    provider.sync = (id: any, selector?: any) => {
      syncedIds.push(id);
      return originalSync(id, selector);
    };

    await dataCell.sync();

    expect(syncedIds).toContain(linkedId);
  });
});
