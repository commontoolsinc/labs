/**
 * Contract tests for frozen-object safety.
 *
 * When `modernDataModel` is ON, `fabricFromNativeValueModern()` deep-freezes all
 * stored objects at commit time. Code paths that read these frozen objects from
 * storage must clone before mutating.
 *
 * The writeOrThrow tests use a two-transaction pattern to exercise the real
 * freeze:
 * - tx1: write data and commit (fabricFromNativeValue freezes the objects)
 * - tx2: read the frozen data and exercise the code path under test
 *
 * The remaining tests verify the defensive cloning contracts directly: that
 * Object.assign propagates frozen nested references, and that deep/shallow
 * cloning produces mutable results.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import { resetDataModelConfig } from "@commonfabric/data-model/fabric-value";
import { resetModernHashConfig } from "@commonfabric/data-model/value-hash";
import { resetJsonEncodingConfig } from "@commonfabric/data-model/json-encoding";

const signer = await Identity.fromPassphrase("test frozen mutation");
const space = signer.did();

function resetAllConfigs() {
  resetDataModelConfig();
  resetModernHashConfig();
  resetJsonEncodingConfig();
}

describe("frozen-object safety contracts", () => {
  describe("writeOrThrow clones frozen parents before mutation", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: {
          modernDataModel: true,
          modernHash: true,
        },
      });
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
      resetAllConfigs();
    });

    it("writes through a frozen parent when intermediate path is missing", async () => {
      // tx1: write {value: {existing: "data"}} and commit. The commit
      // freezes the value object via fabricFromNativeValueModern.
      const tx1 = runtime.edit();
      tx1.writeOrThrow({
        space,
        id: "of:frozen-write-notfound",
        type: "application/json",
        path: [],
      }, { value: { existing: "data" } });
      await tx1.commit();

      // tx2: writeOrThrow to ["value", "newParent", "child"].
      // "newParent" doesn't exist, so tx.write returns NotFoundError.
      // writeOrThrow reads frozen parent at ["value"] and must clone it
      // before setting nextValue["newParent"] = {}.
      const tx2 = runtime.edit();
      const extTx2 = new ExtendedStorageTransaction(tx2.tx);

      expect(() => {
        extTx2.writeOrThrow({
          space,
          id: "of:frozen-write-notfound",
          type: "application/json",
          path: ["value", "newParent", "child"],
        }, "deepValue");
      }).not.toThrow();

      // Verify the write succeeded.
      const result = extTx2.readOrThrow({
        space,
        id: "of:frozen-write-notfound",
        type: "application/json",
        path: ["value", "newParent", "child"],
      });
      expect(result).toBe("deepValue");

      // Verify existing data preserved.
      const existingResult = extTx2.readOrThrow({
        space,
        id: "of:frozen-write-notfound",
        type: "application/json",
        path: ["value", "existing"],
      });
      expect(existingResult).toBe("data");

      await tx2.commit();
    });

    it("writes multiple levels through frozen parents", async () => {
      const tx1 = runtime.edit();
      tx1.writeOrThrow({
        space,
        id: "of:frozen-multi-level",
        type: "application/json",
        path: [],
      }, { value: { a: 1 } });
      await tx1.commit();

      // Writing ["value", "b", "c", "d"] requires creating "b" inside
      // the frozen {a: 1} object.
      const tx2 = runtime.edit();
      const extTx2 = new ExtendedStorageTransaction(tx2.tx);

      expect(() => {
        extTx2.writeOrThrow({
          space,
          id: "of:frozen-multi-level",
          type: "application/json",
          path: ["value", "b", "c", "d"],
        }, "deep");
      }).not.toThrow();

      await tx2.commit();
    });
  });

  describe("setupInternal deep-copies frozen previousInternal", () => {
    // setupInternal uses Object.assign({}, deepCopy(defaults), deepCopy(initial),
    // previousInternal) to merge internal state. When modernDataModel is ON,
    // previousInternal (read from storage) may be deep-frozen. Object.assign
    // copies properties shallowly, so frozen nested references propagate into
    // the mutable result. Deep-copying previousInternal ensures the merged
    // object is fully mutable.

    it("Object.assign propagates frozen nested references", () => {
      const frozen = Object.freeze({
        counter: 0,
        nested: Object.freeze({ items: [1, 2, 3] }),
      });

      // Object.assign copies properties shallowly -- the nested reference
      // is still frozen.
      const merged = Object.assign({}, frozen);
      expect(Object.isFrozen(merged)).toBe(false); // target is mutable
      expect(Object.isFrozen(merged.nested)).toBe(true); // but nested is frozen

      // Mutating the nested reference throws.
      expect(() => {
        (merged.nested as Record<string, unknown>).newProp = "value";
      }).toThrow(TypeError);
    });

    it("deep copy of frozen object produces fully mutable result", () => {
      // cellAwareDeepCopy deep-clones the frozen structure, yielding a fully
      // mutable result. Verified here with structuredClone as a stand-in.
      const frozen = Object.freeze({
        counter: 0,
        nested: Object.freeze({ items: Object.freeze([1, 2, 3]) }),
      });

      // Deep copy yields fully mutable result.
      const copied = structuredClone(frozen) as Record<string, unknown>;
      expect(Object.isFrozen(copied)).toBe(false);
      const nested = (copied as { nested: Record<string, unknown> }).nested;
      expect(Object.isFrozen(nested)).toBe(false);
      nested.newProp = "value";
      expect(nested.newProp).toBe("value");
    });
  });

  describe("createObject clones frozen values before injecting defaults", () => {
    // createObject (schema.ts) injects missing default properties into objects.
    // When the input object is frozen, it must be cloned first. These tests
    // verify the defensive cloning contract.

    it("frozen objects throw TypeError on property assignment", () => {
      // Baseline: frozen object mutation is the hazard being guarded against.
      const frozen = Object.freeze({ name: "Alice" });
      expect(() => {
        (frozen as Record<string, unknown>).age = 30;
      }).toThrow(TypeError);
    });

    it("shallow clone of frozen object is mutable", () => {
      // The cloning contract: clone before mutation.
      const frozen = Object.freeze({ name: "Alice" });
      const cloned: Record<string, unknown> = { ...frozen };
      expect(Object.isFrozen(cloned)).toBe(false);
      cloned.age = 30;
      expect(cloned).toEqual({ name: "Alice", age: 30 });
    });
  });
});
