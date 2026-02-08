/**
 * Runner-level integration tests for v2 storage provider.
 *
 * These tests verify that the v2 provider works end-to-end through the
 * StorageManagerEmulator when memoryVersion is set to "v2".
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("test operator v2");
const space = signer.did();

describe("Storage v2", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let n = 0;

  beforeEach(() => {
    storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });

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
    await new Promise((wake) => setTimeout(wake, 1));
  });

  describe("basic cell operations", () => {
    it("should create and read a cell", () => {
      const cell = runtime.getCell<string>(
        space,
        `v2 test cell ${n++}`,
        undefined,
        tx,
      );

      cell.set("hello v2");
      expect(cell.get()).toEqual("hello v2");
    });

    it("should overwrite a cell value", () => {
      const cell = runtime.getCell<string>(
        space,
        `v2 test cell ${n++}`,
        undefined,
        tx,
      );

      cell.set("first");
      expect(cell.get()).toEqual("first");

      cell.set("second");
      expect(cell.get()).toEqual("second");
    });

    it("should handle object values", () => {
      const cell = runtime.getCell<{ name: string; count: number }>(
        space,
        `v2 test cell ${n++}`,
        undefined,
        tx,
      );

      cell.set({ name: "test", count: 42 });
      expect(cell.get()).toEqual({ name: "test", count: 42 });
    });

    it("should handle array values", () => {
      const cell = runtime.getCell<number[]>(
        space,
        `v2 test cell ${n++}`,
        undefined,
        tx,
      );

      cell.set([1, 2, 3]);
      expect(cell.get()).toEqual([1, 2, 3]);
    });
  });

  describe("persistence", () => {
    it("should persist a cell through commit", async () => {
      const cellId = `v2 persist cell ${n++}`;
      const cell = runtime.getCell<string>(
        space,
        cellId,
        undefined,
        tx,
      );

      cell.send("persisted value");

      await tx.commit();
      tx = runtime.edit();

      // Read back through a new provider
      const provider = storageManager.open(space);
      const uri = cell.getAsNormalizedFullLink().id;
      const entry = provider.get(uri);
      expect(entry?.value).toEqual("persisted value");
    });

    it("should persist multiple cells", async () => {
      const cell1 = runtime.getCell<string>(
        space,
        `v2 multi cell A ${n}`,
        undefined,
        tx,
      );
      const cell2 = runtime.getCell<number>(
        space,
        `v2 multi cell B ${n++}`,
        undefined,
        tx,
      );

      cell1.send("alpha");
      cell2.send(99);

      await tx.commit();
      tx = runtime.edit();

      const provider = storageManager.open(space);
      const entry1 = provider.get(cell1.getAsNormalizedFullLink().id);
      const entry2 = provider.get(cell2.getAsNormalizedFullLink().id);

      expect(entry1?.value).toEqual("alpha");
      expect(entry2?.value).toEqual(99);
    });
  });

  describe("cell references", () => {
    it("should handle cell references", async () => {
      const refCell = runtime.getCell<string>(
        space,
        `v2 ref target ${n}`,
        undefined,
        tx,
      );
      refCell.set("referenced");

      const containerCell = runtime.getCell<{ ref: unknown }>(
        space,
        `v2 ref container ${n++}`,
        undefined,
        tx,
      );
      containerCell.send({
        ref: refCell.getAsLink(),
      });

      await tx.commit();
      tx = runtime.edit();

      const provider = storageManager.open(space);
      const refEntry = provider.get(refCell.getAsNormalizedFullLink().id);
      expect(refEntry?.value).toEqual("referenced");
    });
  });

  describe("sync", () => {
    it("should sync a cell", async () => {
      const cell = runtime.getCell<string>(
        space,
        `v2 sync cell ${n++}`,
        undefined,
        tx,
      );

      let synced = false;
      const uri = cell.getAsNormalizedFullLink().id;
      storageManager.open(space).sync(uri).then(() => (synced = true));
      expect(synced).toBe(false);

      cell.send("sync test");
      await cell.sync();
      expect(synced).toBe(true);
    });
  });

  describe("provider operations", () => {
    it("should send and get through provider directly", async () => {
      const provider = storageManager.open(space);
      const uri = `test:entity:${n++}` as `${string}:${string}`;

      await provider.send([{
        uri,
        value: { value: "direct write", source: undefined },
      }]);

      const value = provider.get(uri);
      expect(value?.value).toEqual("direct write");
    });

    it("should handle provider sink subscriptions", async () => {
      const provider = storageManager.open(space);
      const uri = `test:entity:${n++}` as `${string}:${string}`;

      const values: unknown[] = [];
      const cancel = provider.sink(uri, (value) => {
        values.push(value);
      });

      await provider.send([{
        uri,
        value: { value: "first", source: undefined },
      }]);

      await provider.send([{
        uri,
        value: { value: "second", source: undefined },
      }]);

      // We should have received updates
      expect(values.length).toBeGreaterThanOrEqual(1);

      cancel();
    });
  });
});
