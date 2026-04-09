import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import {
  fabricFromNativeValue,
  getDataModelConfig,
  isFabricValue,
  resetDataModelConfig,
  setDataModelConfig,
  shallowFabricFromNativeValue,
} from "@commonfabric/data-model/fabric-value";
import { FabricError } from "@commonfabric/data-model/fabric-native-instances";
import {
  hashOf,
  resetModernHashConfig,
  setModernHashConfig,
} from "@commonfabric/data-model/value-hash";
import { resetSchemaHashConfig } from "@commonfabric/data-model/schema-hash";

const signer = await Identity.fromPassphrase("test experimental");

/**
 * Tests for the `ExperimentalOptions` feature-flag system: verifies that
 * Runtime construction/disposal correctly propagates flags to the ambient
 * fabric-value config, and that `shallowFabricFromNativeValue`/`fabricFromNativeValue`
 * respect the `modernDataModel` gate.
 */
describe("ExperimentalOptions", () => {
  afterEach(() => {
    resetDataModelConfig();
    resetModernHashConfig();
    resetSchemaHashConfig();
  });

  describe("Runtime construction", () => {
    it("respects explicitly-set flags (all false)", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          modernDataModel: false,
          unifiedJsonEncoding: false,
          modernHash: false,
          modernSchemaHash: false,
        },
      });
      expect(runtime.experimental).toEqual({
        modernDataModel: false,
        richStorableValues: undefined,
        unifiedJsonEncoding: false,
        modernHash: false,
        modernSchemaHash: false,
        canonicalHashing: undefined,
        schedulerHistoricalMightWrite: undefined,
      });
      await runtime.dispose();
      await sm.close();
    });

    it("respects explicitly-set flags (all true)", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          modernDataModel: true,
          unifiedJsonEncoding: true,
          modernHash: true,
          modernSchemaHash: true,
        },
      });
      expect(runtime.experimental).toEqual({
        modernDataModel: true,
        richStorableValues: undefined,
        unifiedJsonEncoding: true,
        modernHash: true,
        modernSchemaHash: true,
        canonicalHashing: undefined,
        schedulerHistoricalMightWrite: undefined,
      });
      await runtime.dispose();
      await sm.close();
    });

    it("merges provided flags with defaults", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          modernDataModel: true,
          modernHash: true,
        },
      });
      expect(runtime.experimental).toEqual({
        modernDataModel: true,
        richStorableValues: undefined,
        unifiedJsonEncoding: undefined,
        modernHash: true,
        modernSchemaHash: undefined,
        canonicalHashing: undefined,
        schedulerHistoricalMightWrite: undefined,
      });
      await runtime.dispose();
      await sm.close();
    });

    it("maps richStorableValues onto modernDataModel when the primary flag is unset", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          richStorableValues: true,
          modernHash: true,
        },
      });
      expect(runtime.experimental.modernDataModel).toBe(true);
      expect(runtime.experimental.richStorableValues).toBe(true);
      await runtime.dispose();
      await sm.close();
    });

    it("maps canonicalHashing onto modernHash when the primary flag is unset", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          canonicalHashing: true,
        },
      });
      expect(runtime.experimental.modernHash).toBe(true);
      expect(runtime.experimental.canonicalHashing).toBe(true);
      await runtime.dispose();
      await sm.close();
    });

    it("preserves the schedulerHistoricalMightWrite flag", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          schedulerHistoricalMightWrite: true,
        },
      });
      expect(runtime.experimental.schedulerHistoricalMightWrite).toBe(true);
      await runtime.dispose();
      await sm.close();
    });
  });

  describe("shallowFabricFromNativeValue with modernDataModel flag", () => {
    it("works normally when flag is OFF", () => {
      setDataModelConfig(false);
      expect(shallowFabricFromNativeValue("hello")).toBe("hello");
      expect(shallowFabricFromNativeValue(42)).toBe(42);
      expect(shallowFabricFromNativeValue(null)).toBe(null);
      expect(shallowFabricFromNativeValue(true)).toBe(true);
      expect(shallowFabricFromNativeValue({ a: 1 })).toEqual({ a: 1 });
    });

    it("converts Error to @Error object when flag is OFF", () => {
      setDataModelConfig(false);
      const err = new Error("test error");
      const result = shallowFabricFromNativeValue(err);
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
      setDataModelConfig(false);
      const result = shallowFabricFromNativeValue([1, undefined, 3]);
      expect(result).toEqual([1, null, 3]);
    });

    it("wraps Error in FabricError when flag is ON", () => {
      setDataModelConfig(true);
      const err = new Error("test error");
      const result = shallowFabricFromNativeValue(err);
      expect(result).toBeInstanceOf(FabricError);
      expect((result as FabricError).error.message).toBe("test error");
    });

    it("preserves undefined in arrays when flag is ON", () => {
      setDataModelConfig(true);
      const arr = [1, undefined, 3];
      const result = shallowFabricFromNativeValue(arr);
      expect(result).toEqual(arr);
      expect((result as unknown[])[1]).toBe(undefined);
    });

    it("returns to flag-OFF behavior after reset", () => {
      setDataModelConfig(true);
      resetDataModelConfig();
      const err = new Error("test");
      const result = shallowFabricFromNativeValue(err);
      expect(result).toHaveProperty("@Error");
    });
  });

  describe("fabricFromNativeValue with modernDataModel flag", () => {
    it("works normally when flag is OFF", () => {
      setDataModelConfig(false);
      expect(fabricFromNativeValue({ a: { b: 1 } })).toEqual({ a: { b: 1 } });
      expect(fabricFromNativeValue([1, 2, 3])).toEqual([1, 2, 3]);
    });

    it("converts nested Error to @Error object when flag is OFF", () => {
      setDataModelConfig(false);
      const err = new Error("nested");
      const result = fabricFromNativeValue({ data: err });
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
      setDataModelConfig(false);
      const result = fabricFromNativeValue({ a: 1, b: undefined, c: 3 });
      expect(result).toEqual({ a: 1, c: 3 });
    });

    it("wraps nested Error in FabricError when flag is ON", () => {
      setDataModelConfig(true);
      const err = new Error("nested");
      const result = fabricFromNativeValue({ data: err }) as Record<
        string,
        unknown
      >;
      expect(result.data).toBeInstanceOf(FabricError);
      expect((result.data as FabricError).error.message).toBe("nested");
    });

    it("preserves undefined-valued object properties when flag is ON", () => {
      setDataModelConfig(true);
      const result = fabricFromNativeValue({ a: 1, b: undefined, c: 3 });
      expect(result).toEqual({ a: 1, b: undefined, c: 3 });
      expect(Object.hasOwn(result as object, "b")).toBe(true);
    });

    it("wraps Error in array in FabricError when flag is ON", () => {
      setDataModelConfig(true);
      const err = new Error("in array");
      const result = fabricFromNativeValue([1, err, 3]) as unknown[];
      expect(result[1]).toBeInstanceOf(FabricError);
      expect((result[1] as FabricError).error.message).toBe("in array");
    });

    it("preserves sparse array holes when flag is ON", () => {
      setDataModelConfig(true);
      // deno-lint-ignore no-sparse-arrays
      const sparse = [1, , 3];
      const result = fabricFromNativeValue(sparse) as unknown[];
      expect(result.length).toBe(3);
      expect(0 in result).toBe(true);
      expect(1 in result).toBe(false); // hole preserved
      expect(2 in result).toBe(true);
    });

    it("returns to flag-OFF behavior after reset", () => {
      setDataModelConfig(true);
      resetDataModelConfig();
      const result = fabricFromNativeValue({ a: 1, b: undefined });
      expect(result).toEqual({ a: 1 });
    });

    it("caches correctly when toJSON() returns undefined (no false cache miss)", () => {
      setDataModelConfig(true);
      // An object whose toJSON() returns undefined. In the rich path, undefined
      // is a valid FabricValue, so this gets stored in the converted map as
      // `undefined`. The bug (before the has() fix) would treat a subsequent
      // lookup as a cache miss because `converted.get(obj) === undefined` can't
      // distinguish "stored undefined" from "key not found".
      const undef = { toJSON: () => undefined };
      const result = fabricFromNativeValue({ a: undef, b: undef }) as Record<
        string,
        unknown
      >;
      // Both slots should be undefined (the converted value).
      expect(result.a).toBe(undefined);
      expect(result.b).toBe(undefined);
      expect(Object.hasOwn(result, "a")).toBe(true);
      expect(Object.hasOwn(result, "b")).toBe(true);
      // No error thrown -- without the fix, the second encounter would re-mark
      // the object as PROCESSING and then attempt to re-convert it, which could
      // produce incorrect results or throw on circular reference detection.
    });
  });

  describe("isFabricValue with modernDataModel flag", () => {
    it("rejects Error when flag is OFF", () => {
      setDataModelConfig(false);
      expect(isFabricValue(new Error("test"))).toBe(false);
    });

    it("rejects [undefined] when flag is OFF", () => {
      setDataModelConfig(false);
      expect(isFabricValue([undefined])).toBe(false);
    });

    it("rejects Error even when flag is ON (needs conversion to FabricError)", () => {
      setDataModelConfig(true);
      expect(isFabricValue(new Error("test"))).toBe(false);
    });

    it("accepts [undefined] when flag is ON", () => {
      setDataModelConfig(true);
      expect(isFabricValue([undefined])).toBe(true);
    });

    it("accepts sparse arrays when flag is ON", () => {
      setDataModelConfig(true);
      // deno-lint-ignore no-sparse-arrays
      const sparse = [1, , 3];
      expect(isFabricValue(sparse)).toBe(true);
    });

    it("accepts sparse arrays when flag is OFF", () => {
      setDataModelConfig(false);
      // deno-lint-ignore no-sparse-arrays
      const sparse = [1, , 3];
      expect(isFabricValue(sparse)).toBe(true);
    });

    it("returns to flag-OFF behavior after reset", () => {
      setDataModelConfig(true);
      resetDataModelConfig();
      expect(isFabricValue(new Error("test"))).toBe(false);
      expect(isFabricValue([undefined])).toBe(false);
    });
  });

  describe("Runtime sets and resets global config", () => {
    it("constructing Runtime with modernDataModel sets global config", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          modernDataModel: true,
          modernHash: true,
        },
      });

      expect(getDataModelConfig()).toBe(true);

      await runtime.dispose();
      await sm.close();
    });

    it("constructing Runtime with explicit false sets config to false", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: { modernDataModel: false },
      });

      expect(getDataModelConfig()).toBe(false);

      await runtime.dispose();
      await sm.close();
    });

    it("constructing Runtime with explicit true sets config to true", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: { modernDataModel: true, modernHash: true },
      });

      expect(getDataModelConfig()).toBe(true);

      await runtime.dispose();
      await sm.close();
    });

    it("disposing Runtime resets global config", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          modernDataModel: true,
          modernHash: true,
        },
      });

      expect(getDataModelConfig()).toBe(true);

      await runtime.dispose();
      await sm.close();

      expect(getDataModelConfig()).toBe(false);
    });
  });

  describe("hashOf() with modernHash flag", () => {
    it("works normally when modernHash is false", () => {
      setModernHashConfig(false);
      const ref = hashOf("hello");
      expect(ref).toBeDefined();
      expect(typeof ref.toString()).toBe("string");
    });

    it("produces a valid reference when modernHash is true", () => {
      setModernHashConfig(true);
      const ref = hashOf("hello");
      expect(ref).toBeDefined();
      expect(typeof ref.toString()).toBe("string");
    });

    it("works again after reset", () => {
      setModernHashConfig(true);
      resetModernHashConfig();
      const ref = hashOf("hello");
      expect(ref).toBeDefined();
    });
  });

  describe("Runtime sets and resets modernHash config", () => {
    it("constructing Runtime with modernHash enables canonical hashOf()", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: { modernHash: true },
      });

      const ref = hashOf("test");
      expect(ref).toBeDefined();
      expect(typeof ref.toString()).toBe("string");

      await runtime.dispose();
      await sm.close();
    });

    it("disposing Runtime resets modernHash so hashOf() uses default path", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: { modernHash: true },
      });

      const canonicalRef = hashOf("test");
      expect(canonicalRef).toBeDefined();

      await runtime.dispose();
      await sm.close();

      const defaultRef = hashOf("test");
      expect(defaultRef).toBeDefined();
    });
  });
});
