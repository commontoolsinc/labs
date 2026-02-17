import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import {
  getExperimentalStorableConfig,
  isStorableValue,
  resetExperimentalStorableConfig,
  setExperimentalStorableConfig,
  toDeepStorableValue,
  toStorableValue,
} from "@commontools/memory/storable-value";
import {
  refer,
  resetCanonicalHashConfig,
  setCanonicalHashConfig,
} from "@commontools/memory/reference";

const signer = await Identity.fromPassphrase("test experimental");

/**
 * Tests for the `ExperimentalOptions` feature-flag system: verifies that
 * Runtime construction/disposal correctly propagates flags to the ambient
 * storable-value config, and that `toStorableValue`/`toDeepStorableValue`
 * respect the `richStorableValues` gate.
 */
describe("ExperimentalOptions", () => {
  afterEach(() => {
    resetExperimentalStorableConfig();
    resetCanonicalHashConfig();
  });

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
        canonicalHashing: false,
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
        canonicalHashing: false,
      });
      await runtime.dispose();
      await sm.close();
    });
  });

  describe("toStorableValue with richStorableValues flag", () => {
    it("works normally when flag is OFF (default)", () => {
      expect(toStorableValue("hello")).toBe("hello");
      expect(toStorableValue(42)).toBe(42);
      expect(toStorableValue(null)).toBe(null);
      expect(toStorableValue(true)).toBe(true);
      expect(toStorableValue({ a: 1 })).toEqual({ a: 1 });
    });

    it("converts Error to @Error object when flag is OFF", () => {
      const err = new Error("test error");
      const result = toStorableValue(err);
      expect(result).toEqual({
        "@Error": {
          name: "Error",
          message: "test error",
          stack: err.stack,
          cause: undefined,
        },
      });
    });

    it("converts undefined in arrays to null when flag is OFF", () => {
      const result = toStorableValue([1, undefined, 3]);
      expect(result).toEqual([1, null, 3]);
    });

    it("preserves Error as-is when flag is ON", () => {
      setExperimentalStorableConfig({ richStorableValues: true });
      const err = new Error("test error");
      const result = toStorableValue(err);
      expect(result).toBe(err);
    });

    it("preserves undefined in arrays when flag is ON", () => {
      setExperimentalStorableConfig({ richStorableValues: true });
      const arr = [1, undefined, 3];
      const result = toStorableValue(arr);
      expect(result).toBe(arr);
    });

    it("returns to flag-OFF behavior after reset", () => {
      setExperimentalStorableConfig({ richStorableValues: true });
      resetExperimentalStorableConfig();
      const err = new Error("test");
      const result = toStorableValue(err);
      expect(result).toHaveProperty("@Error");
    });
  });

  describe("toDeepStorableValue with richStorableValues flag", () => {
    it("works normally when flag is OFF (default)", () => {
      expect(toDeepStorableValue({ a: { b: 1 } })).toEqual({ a: { b: 1 } });
      expect(toDeepStorableValue([1, 2, 3])).toEqual([1, 2, 3]);
    });

    it("converts nested Error to @Error object when flag is OFF", () => {
      const err = new Error("nested");
      const result = toDeepStorableValue({ data: err });
      expect(result).toEqual({
        data: {
          "@Error": {
            name: "Error",
            message: "nested",
            stack: err.stack,
            cause: undefined,
          },
        },
      });
    });

    it("omits undefined-valued object properties when flag is OFF", () => {
      const result = toDeepStorableValue({ a: 1, b: undefined, c: 3 });
      expect(result).toEqual({ a: 1, c: 3 });
    });

    it("preserves nested Error as-is when flag is ON", () => {
      setExperimentalStorableConfig({ richStorableValues: true });
      const err = new Error("nested");
      const result = toDeepStorableValue({ data: err }) as Record<
        string,
        unknown
      >;
      expect(result.data).toBe(err);
    });

    it("preserves undefined-valued object properties when flag is ON", () => {
      setExperimentalStorableConfig({ richStorableValues: true });
      const result = toDeepStorableValue({ a: 1, b: undefined, c: 3 });
      expect(result).toEqual({ a: 1, b: undefined, c: 3 });
      expect(Object.hasOwn(result as object, "b")).toBe(true);
    });

    it("preserves Error in array when flag is ON", () => {
      setExperimentalStorableConfig({ richStorableValues: true });
      const err = new Error("in array");
      const result = toDeepStorableValue([1, err, 3]) as unknown[];
      expect(result[1]).toBe(err);
    });

    it("preserves sparse array holes when flag is ON", () => {
      setExperimentalStorableConfig({ richStorableValues: true });
      // deno-lint-ignore no-sparse-arrays
      const sparse = [1, , 3];
      const result = toDeepStorableValue(sparse) as unknown[];
      expect(result.length).toBe(3);
      expect(0 in result).toBe(true);
      expect(1 in result).toBe(false); // hole preserved
      expect(2 in result).toBe(true);
    });

    it("returns to flag-OFF behavior after reset", () => {
      setExperimentalStorableConfig({ richStorableValues: true });
      resetExperimentalStorableConfig();
      const result = toDeepStorableValue({ a: 1, b: undefined });
      expect(result).toEqual({ a: 1 });
    });
  });

  describe("isStorableValue with richStorableValues flag", () => {
    it("rejects Error when flag is OFF", () => {
      expect(isStorableValue(new Error("test"))).toBe(false);
    });

    it("rejects [undefined] when flag is OFF", () => {
      expect(isStorableValue([undefined])).toBe(false);
    });

    it("accepts Error when flag is ON", () => {
      setExperimentalStorableConfig({ richStorableValues: true });
      expect(isStorableValue(new Error("test"))).toBe(true);
    });

    it("accepts [undefined] when flag is ON", () => {
      setExperimentalStorableConfig({ richStorableValues: true });
      expect(isStorableValue([undefined])).toBe(true);
    });

    it("accepts sparse arrays when flag is ON", () => {
      setExperimentalStorableConfig({ richStorableValues: true });
      // deno-lint-ignore no-sparse-arrays
      const sparse = [1, , 3];
      expect(isStorableValue(sparse)).toBe(true);
    });

    it("rejects sparse arrays when flag is OFF", () => {
      // deno-lint-ignore no-sparse-arrays
      const sparse = [1, , 3];
      expect(isStorableValue(sparse)).toBe(false);
    });

    it("returns to flag-OFF behavior after reset", () => {
      setExperimentalStorableConfig({ richStorableValues: true });
      resetExperimentalStorableConfig();
      expect(isStorableValue(new Error("test"))).toBe(false);
      expect(isStorableValue([undefined])).toBe(false);
    });
  });

  describe("Runtime sets and resets global config", () => {
    it("constructing Runtime with richStorableValues sets global config", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: { richStorableValues: true },
      });

      const config = getExperimentalStorableConfig();
      expect(config.richStorableValues).toBe(true);

      await runtime.dispose();
      await sm.close();
    });

    it("constructing Runtime without experimental leaves config at defaults", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
      });

      const config = getExperimentalStorableConfig();
      expect(config.richStorableValues).toBe(false);

      await runtime.dispose();
      await sm.close();
    });

    it("disposing Runtime resets global config", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: { richStorableValues: true },
      });

      expect(getExperimentalStorableConfig().richStorableValues).toBe(true);

      await runtime.dispose();
      await sm.close();

      expect(getExperimentalStorableConfig().richStorableValues).toBe(false);
    });
  });

  describe("refer() with canonicalHashing flag", () => {
    it("works normally when canonicalHashing is false (default)", () => {
      const ref = refer("hello");
      expect(ref).toBeDefined();
      expect(typeof ref.toString()).toBe("string");
    });

    it("throws when canonicalHashing is true", () => {
      setCanonicalHashConfig(true);
      expect(() => {
        refer("hello");
      }).toThrow("canonicalHashing not yet implemented");
    });

    it("works again after reset", () => {
      setCanonicalHashConfig(true);
      resetCanonicalHashConfig();
      const ref = refer("hello");
      expect(ref).toBeDefined();
    });
  });

  describe("Runtime sets and resets canonicalHashing config", () => {
    it("constructing Runtime with canonicalHashing causes refer() to throw", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: { canonicalHashing: true },
      });

      expect(() => {
        refer("test");
      }).toThrow("canonicalHashing not yet implemented");

      await runtime.dispose();
      await sm.close();
    });

    it("disposing Runtime resets canonicalHashing so refer() works again", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: { canonicalHashing: true },
      });

      expect(() => refer("test")).toThrow(
        "canonicalHashing not yet implemented",
      );

      await runtime.dispose();
      await sm.close();

      const ref = refer("test");
      expect(ref).toBeDefined();
    });
  });
});
