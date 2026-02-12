import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { dispatchToStorableValue, dispatchToDeepStorableValue } from "../src/storable-dispatch.ts";
import { convertCellsToLinks } from "../src/cell.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test experimental");
const space = signer.did();

describe("ExperimentalOptions", () => {
  describe("Runtime construction", () => {
    it("defaults all flags to false when no experimental options given", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
      });
      expect(runtime.experimental).toEqual({
        richStorableValues: false,
        storableProtocol: false,
        unifiedJsonEncoding: false,
      });
      await runtime.dispose();
      await sm.close();
    });

    it("merges provided flags with defaults", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: { richStorableValues: true },
      });
      expect(runtime.experimental).toEqual({
        richStorableValues: true,
        storableProtocol: false,
        unifiedJsonEncoding: false,
      });
      await runtime.dispose();
      await sm.close();
    });
  });

  describe("dispatchToStorableValue", () => {
    it("delegates to toStorableValue when richStorableValues is false", () => {
      const result = dispatchToStorableValue("hello", { richStorableValues: false });
      expect(result).toBe("hello");
    });

    it("delegates to toStorableValue when no experimental options given", () => {
      const result = dispatchToStorableValue(42);
      expect(result).toBe(42);
    });

    it("throws when richStorableValues is true", () => {
      expect(() => {
        dispatchToStorableValue("hello", { richStorableValues: true });
      }).toThrow("richStorableValues not yet implemented");
    });
  });

  describe("dispatchToDeepStorableValue", () => {
    it("delegates to toDeepStorableValue when richStorableValues is false", () => {
      const result = dispatchToDeepStorableValue({ a: 1 }, { richStorableValues: false });
      expect(result).toEqual({ a: 1 });
    });

    it("throws when richStorableValues is true", () => {
      expect(() => {
        dispatchToDeepStorableValue({ a: 1 }, { richStorableValues: true });
      }).toThrow("richStorableValues not yet implemented");
    });
  });

  describe("dispatch wired into cell.ts setRaw", () => {
    let runtime: Runtime;
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let tx: IExtendedStorageTransaction;

    afterEach(async () => {
      await tx?.commit();
      await runtime?.dispose();
      await storageManager?.close();
    });

    it("setRaw works normally without experimental flags", () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      tx = runtime.edit();
      const cell = runtime.getCell(space, "setRaw normal", undefined, tx);
      cell.setRaw({ value: 42 });
      expect(cell.getRaw()).toEqual({ value: 42 });
    });

    it("setRaw throws when richStorableValues is enabled", () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { richStorableValues: true },
      });
      tx = runtime.edit();
      const cell = runtime.getCell(space, "setRaw experimental", undefined, tx);
      expect(() => {
        cell.setRaw({ value: 42 });
      }).toThrow("richStorableValues not yet implemented");
    });
  });

  describe("dispatch wired into data-updating.ts normalizeAndDiff", () => {
    let runtime: Runtime;
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let tx: IExtendedStorageTransaction;

    afterEach(async () => {
      await tx?.commit();
      await runtime?.dispose();
      await storageManager?.close();
    });

    it("cell.set works normally without experimental flags", () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      tx = runtime.edit();
      const cell = runtime.getCell<number>(space, "set normal", undefined, tx);
      cell.set(42);
      expect(cell.get()).toBe(42);
    });

    it("cell.set throws when richStorableValues is enabled", () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { richStorableValues: true },
      });
      tx = runtime.edit();
      const cell = runtime.getCell<number>(space, "set experimental", undefined, tx);
      expect(() => {
        cell.set(42);
      }).toThrow("richStorableValues not yet implemented");
    });
  });

  describe("dispatch wired into convertCellsToLinks", () => {
    it("works normally without experimental options", () => {
      const result = convertCellsToLinks({ a: 1 });
      expect(result).toEqual({ a: 1 });
    });

    it("throws when richStorableValues is enabled via options", () => {
      expect(() => {
        convertCellsToLinks({ a: 1 }, { experimental: { richStorableValues: true } });
      }).toThrow("richStorableValues not yet implemented");
    });
  });

  describe("experimental options threaded to transaction", () => {
    it("edit() sets experimental on the underlying transaction", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: { richStorableValues: true },
      });
      const tx = runtime.edit();
      expect(tx.tx.experimental).toEqual({
        richStorableValues: true,
        storableProtocol: false,
        unifiedJsonEncoding: false,
      });
      await tx.commit();
      await runtime.dispose();
      await sm.close();
    });
  });
});
