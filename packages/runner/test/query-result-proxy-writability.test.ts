/**
 * A query-result proxy is built either read-only or writable, and the two
 * carry different write traps. Both are cached per transaction, and the value
 * index that backs that cache is consulted for the writability actually asked
 * for -- so which of the two a caller receives is decided by what they asked
 * for, never by which one happened to be built first.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test proxy writability");
const space = signer.did();

const READ_ONLY_REFUSAL = "This value is read-only";

describe("query-result-proxy", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
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

  describe("writability of a cached view", () => {
    // Both views are taken over one cell in one transaction, so they name the
    // same value object -- the case where the two share a cache entry. Each
    // test names the order they are built in, and both orders are exercised,
    // because a view behaves the same whichever of the two was built first.
    const views = (id: string, order: "read-only first" | "writable first") => {
      const cell = runtime.getCell<{ a: number }>(space, id, undefined, tx);
      cell.set({ a: 1 });
      const readOnlyFirst = order === "read-only first";
      const first = cell.getAsQueryResult([], tx, !readOnlyFirst) as {
        a: number;
      };
      const second = cell.getAsQueryResult([], tx, readOnlyFirst) as {
        a: number;
      };
      return readOnlyFirst
        ? { readOnly: first, writable: second, cell }
        : { writable: first, readOnly: second, cell };
    };

    it("throws on a write through a read-only view built before a writable one", () => {
      const { readOnly } = views("ro-then-rw", "read-only first");
      expect(() => {
        readOnly.a = 2;
      }).toThrow(READ_ONLY_REFUSAL);
    });

    it("throws on a write through a read-only view built after a writable one", () => {
      const { readOnly } = views("rw-then-ro", "writable first");
      expect(() => {
        readOnly.a = 2;
      }).toThrow(READ_ONLY_REFUSAL);
    });

    it("stores a write through a writable view built before a read-only one", () => {
      const { writable, cell } = views("rw-then-ro-write", "writable first");
      writable.a = 3;
      expect(cell.get().a).toBe(3);
    });

    it("stores a write through a writable view built after a read-only one", () => {
      const { writable, cell } = views("ro-then-rw-write", "read-only first");
      writable.a = 3;
      expect(cell.get().a).toBe(3);
    });

    it("returns distinct views for the two writabilities over one value", () => {
      const { readOnly, writable } = views("distinct", "read-only first");
      expect(readOnly as object).not.toBe(writable as object);
    });

    it("returns the same view for two read-only reads of one value", () => {
      const cell = runtime.getCell<{ a: number }>(
        space,
        "shared-read-only",
        undefined,
        tx,
      );
      cell.set({ a: 1 });
      const first = cell.getAsQueryResult([], tx, false) as object;
      const second = cell.getAsQueryResult([], tx, false) as object;
      expect(first).toBe(second);
    });

    it("returns the same view for two writable reads of one value", () => {
      const cell = runtime.getCell<{ a: number }>(
        space,
        "shared-writable",
        undefined,
        tx,
      );
      cell.set({ a: 1 });
      const first = cell.getAsQueryResult([], tx, true) as object;
      const second = cell.getAsQueryResult([], tx, true) as object;
      expect(first).toBe(second);
    });
  });
});
