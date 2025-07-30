import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Runtime } from "../src/runtime.ts";
import { type Cell } from "../src/cell.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Storage", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let testCell: Cell<any>;
  let n = 0;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });

    tx = runtime.edit();

    testCell = runtime.getCell<string>(
      space,
      `storage test cell ${n++}`,
      undefined,
      tx,
    );
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.storage.cancelAll();
    await storageManager?.close();
    // _processCurrentBatch leaves sleep behind that makes deno error
    await new Promise((wake) => setTimeout(wake, 1));
  });

  describe("persistDoc", () => {
    it("should persist a doc", async () => {
      const testValue = { data: "test" };
      testCell.send(testValue);

      await tx.commit();
      tx = runtime.edit();

      if (runtime.storage.shim) await testCell.sync();

      const query = storageManager
        .mount(space)
        .query({
          select: { _: { "application/json": {} } },
        });

      await query;

      const [fact] = query.facts;

      expect(fact).toBeDefined();
      expect(fact.is).toEqual({ value: testValue });
    });

    it("should persist a cells and referenced cell references within it", async () => {
      const refCell = runtime.getCell<string>(
        space,
        "should persist a cells and referenced cell references within it",
        undefined,
        tx,
      );
      refCell.set("hello");

      const testValue = {
        data: "test",
        ref: refCell.getAsLink(),
      };
      testCell.send(testValue);

      // Commit transaction to persist data
      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      if (runtime.storage.shim) await testCell.sync();

      const entry = storageManager.open(space).get(
        refCell.getAsNormalizedFullLink().id,
      );
      expect(entry?.value).toEqual("hello");
    });

    it("should persist a cells and referenced cells within it", async () => {
      const refCell = runtime.getCell<string>(
        space,
        "should persist a cells and referenced cells 1",
        undefined,
        tx,
      );
      refCell.set("hello");

      const testValue = {
        data: "test",
        otherDoc: refCell,
      };
      testCell.send(testValue);

      // Commit transaction to persist data
      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      if (runtime.storage.shim) await testCell.sync();

      const refCellURI = refCell.getAsNormalizedFullLink().id;
      const entry = storageManager.open(space).get(refCellURI);
      expect(entry?.value).toEqual("hello");
    });
  });

  describe("doc updates", () => {
    it("should persist doc updates", async () => {
      testCell.send("value 1");
      testCell.send("value 2");

      // Commit transaction to persist data
      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      if (runtime.storage.shim) await testCell.sync();

      const query = storageManager
        .mount(space)
        .query({
          select: { _: { "application/json": {} } },
        });

      await query;

      const [fact] = query.facts;

      expect(fact?.is).toEqual({ value: "value 2" });
    });
  });

  describe("syncDoc", () => {
    it("should wait for a doc to appear", async () => {
      let synced = false;

      const testCellURI = testCell.getAsNormalizedFullLink().id;
      storageManager.open(space).sync(testCellURI).then(
        () => (synced = true),
      );
      expect(synced).toBe(false);

      testCell.send("test");
      await testCell.sync();
      expect(synced).toBe(true);
    });

    it("should wait for a undefined doc to appear", async () => {
      let synced = false;
      const testCellURI = testCell.getAsNormalizedFullLink().id;
      storageManager.open(space).sync(testCellURI).then(
        () => (synced = true),
      );
      expect(synced).toBe(false);

      await testCell.sync();
      expect(synced).toBe(true);
    });

    it("should wait for a undefined doc to appear with schema and double sync", async () => {
      let synced = false;
      const selector = {
        path: [],
        schemaContext: { schema: true, rootSchema: true },
      };
      const testCellURI = testCell.getAsNormalizedFullLink().id;
      storageManager.open(space).sync(testCellURI, selector)
        .then(
          () => (synced = true),
        );
      storageManager.open(space).sync(testCellURI, selector)
        .then(
          () => (synced = true),
        );
      // yield, so that if the second sync returns immediately,
      // we'll get our callback
      await Promise.resolve(true);

      expect(synced).toBe(false);

      await testCell.sync();
      expect(synced).toBe(true);
    });
  });

  describe("ephemeral docs", () => {
    it("should not be loaded from storage", async () => {
      if (!runtime.storage.shim) return;

      const ephemeralCell = runtime.getCell<string>(
        space,
        "ephemeral",
        undefined,
        tx,
      );
      ephemeralCell.set("transient");
      ephemeralCell.getDoc().ephemeral = true;
      await ephemeralCell.sync();
      const provider = storageManager.open(space);

      const ephemeralCellURI = ephemeralCell.getAsNormalizedFullLink().id;
      await provider.sync(ephemeralCellURI);
      const record = provider.get(ephemeralCellURI);
      expect(record).toBeUndefined();
    });
  });

  describe("doc updates", () => {
    it("should persist doc updates with schema", async () => {
      testCell.send("value 1");
      testCell.send("value 2");

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      if (runtime.storage.shim) await testCell.sync();

      await runtime.storage.synced();

      const query = storageManager
        .mount(space)
        .query({
          select: { _: { "application/json": {} } },
        });

      await query;

      const [fact] = query.facts;

      expect(fact?.is).toEqual({ value: "value 2" });
    });
  });
});
