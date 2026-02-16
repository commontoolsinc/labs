import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import {
  getExperimentalStorableConfig,
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

  describe("toStorableValue with global config", () => {
    it("works normally when richStorableValues is false (default)", () => {
      expect(toStorableValue("hello")).toBe("hello");
      expect(toStorableValue(42)).toBe(42);
      expect(toStorableValue(null)).toBe(null);
      expect(toStorableValue(true)).toBe(true);
      expect(toStorableValue({ a: 1 })).toEqual({ a: 1 });
    });

    it("throws when richStorableValues is true", () => {
      setExperimentalStorableConfig({ richStorableValues: true });
      expect(() => {
        toStorableValue("hello");
      }).toThrow("richStorableValues not yet implemented");
    });

    it("works again after reset", () => {
      setExperimentalStorableConfig({ richStorableValues: true });
      resetExperimentalStorableConfig();
      expect(toStorableValue("hello")).toBe("hello");
    });
  });

  describe("toDeepStorableValue with global config", () => {
    it("works normally when richStorableValues is false (default)", () => {
      expect(toDeepStorableValue({ a: { b: 1 } })).toEqual({ a: { b: 1 } });
      expect(toDeepStorableValue([1, 2, 3])).toEqual([1, 2, 3]);
    });

    it("throws when richStorableValues is true", () => {
      setExperimentalStorableConfig({ richStorableValues: true });
      expect(() => {
        toDeepStorableValue({ a: 1 });
      }).toThrow("richStorableValues not yet implemented");
    });

    it("works again after reset", () => {
      setExperimentalStorableConfig({ richStorableValues: true });
      resetExperimentalStorableConfig();
      expect(toDeepStorableValue({ a: 1 })).toEqual({ a: 1 });
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
