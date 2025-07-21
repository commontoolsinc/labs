import { afterEach, beforeEach, describe, it } from "./helpers/tx-bdd.ts";
import { expect } from "@std/expect";
import { Runtime } from "../src/runtime.ts";
import { type Cell } from "../src/cell.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Storage", (config) => {
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
      useStorageManagerTransactions: config.useStorageManagerTransactions,
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
    it.skip({ useStorageManagerTransactions: true }, "should persist a doc", async () => {
      const testValue = { data: "test" };
      testCell.send(testValue);

      await testCell.sync();

      const query = storageManager
        .mount(space)
        .query({
          select: { _: { "application/json": {} } },
        });

      await query;

      const [fact] = query.facts;

      expect(fact.is).toEqual({ value: testValue });
    });

    it.skip({ useStorageManagerTransactions: true }, "should persist a cells and referenced cell references within it", async () => {
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

      await testCell.sync();

      const entry = storageManager.open(space).get(refCell.entityId!);
      expect(entry?.value).toEqual("hello");
    });

    it.skip({ useStorageManagerTransactions: true }, "should persist a cells and referenced cells within it", async () => {
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

      await testCell.sync();

      const entry = storageManager.open(space).get(refCell.entityId!);
      expect(entry?.value).toEqual("hello");
    });
  });

  describe("doc updates", () => {
    it.skip({ useStorageManagerTransactions: true }, "should persist doc updates", async () => {
      await testCell.sync();

      testCell.send("value 1");
      testCell.send("value 2");

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

  describe("syncDoc", () => {
    it.skip({ useStorageManagerTransactions: true }, "should wait for a doc to appear", async () => {
      let synced = false;

      storageManager.open(space).sync(testCell.entityId!, true).then(
        () => (synced = true),
      );
      expect(synced).toBe(false);

      testCell.send("test");
      await testCell.sync();
      expect(synced).toBe(true);
    });

    it.skip({ useStorageManagerTransactions: true }, "should wait for a undefined doc to appear", async () => {
      let synced = false;
      storageManager.open(space).sync(testCell.entityId!, true).then(
        () => (synced = true),
      );
      expect(synced).toBe(false);

      await testCell.sync();
      expect(synced).toBe(true);
    });
  });

  describe("ephemeral docs", () => {
    it.skip({ useStorageManagerTransactions: true }, "should not be loaded from storage", async () => {
      const ephemeralDoc = runtime.getCell<string>(
        space,
        "ephemeral",
        undefined,
        tx,
      );
      ephemeralDoc.set("transient");
      ephemeralDoc.getDoc().ephemeral = true;
      await ephemeralDoc.sync();
      const provider = storageManager.open(space);

      await provider.sync(ephemeralDoc.entityId!);
      const record = provider.get(ephemeralDoc.entityId!);
      expect(record).toBeUndefined();
    });
  });

  describe("doc updates", () => {
    it.skip({ useStorageManagerTransactions: true }, "should persist doc updates with schema", async () => {
      await testCell.sync();

      testCell.send("value 1");
      testCell.send("value 2");

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
