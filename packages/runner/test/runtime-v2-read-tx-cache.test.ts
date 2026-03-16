import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("runtime-v2-read-tx-cache");
const space = signer.did();

describe("Runtime v2 ambient read transaction", () => {
  it("reuses a single ambient read transaction for repeated reads", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });
    let editCalls = 0;
    const instrumented = storageManager as typeof storageManager & {
      edit: typeof storageManager.edit;
    };
    const originalEdit = storageManager.edit.bind(storageManager);
    instrumented.edit = () => {
      editCalls += 1;
      return originalEdit();
    };

    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      memoryVersion: "v2",
    });

    try {
      const seed = runtime.edit();
      const cell = runtime.getCell(
        space,
        "runtime-v2-ambient-read-reuse",
        { type: "number" } as const,
        seed,
      );
      cell.set(42);
      await seed.commit();

      const baseline = editCalls;
      expect(cell.get()).toBe(42);
      expect(cell.get()).toBe(42);
      expect(cell.get()).toBe(42);
      expect(editCalls - baseline).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("invalidates the ambient read transaction after commits", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });
    let editCalls = 0;
    const instrumented = storageManager as typeof storageManager & {
      edit: typeof storageManager.edit;
    };
    const originalEdit = storageManager.edit.bind(storageManager);
    instrumented.edit = () => {
      editCalls += 1;
      return originalEdit();
    };

    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      memoryVersion: "v2",
    });

    try {
      const seed = runtime.edit();
      const cell = runtime.getCell(
        space,
        "runtime-v2-ambient-read-invalidate",
        { type: "number" } as const,
        seed,
      );
      cell.set(1);
      await seed.commit();

      expect(cell.get()).toBe(1);
      expect(cell.get()).toBe(1);
      const afterFirstReads = editCalls;

      const update = runtime.edit();
      cell.withTx(update).set(2);
      await update.commit();

      expect(cell.get()).toBe(2);
      expect(editCalls - afterFirstReads).toBe(2);
      expect(cell.get()).toBe(2);
      expect(editCalls - afterFirstReads).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });
});
