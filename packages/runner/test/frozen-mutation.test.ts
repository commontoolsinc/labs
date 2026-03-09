/**
 * BDD tests for frozen-object mutation fixes.
 *
 * When `richStorableValues` is ON, `toDeepRichStorableValue()` deep-freezes all
 * stored objects at commit time. Several code paths read these frozen objects
 * from storage and then try to mutate them, causing TypeErrors.
 *
 * Fix 1 uses a two-transaction pattern to exercise the real freeze:
 * - tx1: write data and commit (toDeepStorableValue freezes the objects)
 * - tx2: read the frozen data and exercise the code path under test
 *
 * Fix 2 and Fix 3 are defensive fixes whose exact code paths are deep in the
 * runtime pipeline (setupInternal, schema traversal). These tests verify the
 * vulnerability pattern directly: frozen nested references propagate through
 * Object.assign and cause TypeErrors when mutated.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import {
  resetExperimentalStorableConfig,
} from "@commontools/memory/storable-value";
import { resetCanonicalHashConfig } from "@commontools/memory/reference";
import {
  resetJsonEncodingConfig,
} from "@commontools/memory/json-encoding-dispatch";
import {
  resetStorableValueConfig,
} from "@commontools/memory/storable-value-dispatch";

const signer = await Identity.fromPassphrase("test frozen mutation");
const space = signer.did();

function resetAllConfigs() {
  resetExperimentalStorableConfig();
  resetCanonicalHashConfig();
  resetJsonEncodingConfig();
  resetStorableValueConfig();
}

describe("frozen-object mutation fixes", () => {
  describe("Fix 1: writeOrThrow with frozen parent object", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: {
          richStorableValues: true,
          canonicalHashing: true,
        },
      });
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
      resetAllConfigs();
    });

    it("should write through a frozen parent when intermediate path is missing", async () => {
      // tx1: write {value: {existing: "data"}} and commit. The commit
      // freezes the value object via toDeepRichStorableValue.
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
      // writeOrThrow reads frozen parent at ["value"] and tries to set
      // nextValue["newParent"] = {} on it.
      // Without the fix: TypeError "Cannot add property, object is not extensible"
      // With the fix: shallow-clones the frozen parent before mutation.
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

    it("should write multiple levels through frozen parents", async () => {
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

  describe("Fix 2: setupInternal frozen previousInternal (defensive)", () => {
    // setupInternal uses Object.assign({}, deepCopy(defaults), deepCopy(initial),
    // previousInternal) to merge internal state. When richStorableValues is ON,
    // previousInternal (read from storage) may be deep-frozen. Object.assign
    // copies properties shallowly, so frozen nested references propagate into
    // the mutable result. Downstream code that mutates internal.nested would throw.
    //
    // The fix wraps previousInternal in cellAwareDeepCopy when richStorableValues
    // is ON. This test verifies the vulnerability pattern directly.

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
      // The fix uses cellAwareDeepCopy which deep-clones the frozen structure.
      // Import not needed -- we just verify the pattern with structuredClone.
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

  describe("Fix 3: schema default injection on frozen objects (defensive)", () => {
    // The traversal currently creates fresh mutable objects before passing
    // them to createObject, so the frozen mutation path in schema.ts:583
    // is not reachable through the standard pipeline. This fix is defensive:
    // it ensures createObject is safe for any caller, including future code
    // paths that might pass frozen values.
    //
    // This test verifies the vulnerability directly: mutating a frozen object
    // throws TypeError, and the Object.isFrozen guard prevents it.

    it("frozen objects throw TypeError on property assignment", () => {
      // Baseline: verify that frozen object mutation is the actual hazard.
      const frozen = Object.freeze({ name: "Alice" });
      expect(() => {
        (frozen as Record<string, unknown>).age = 30;
      }).toThrow(TypeError);
    });

    it("shallow clone of frozen object is mutable", () => {
      // The fix pattern: clone before mutation.
      const frozen = Object.freeze({ name: "Alice" });
      const cloned: Record<string, unknown> = { ...frozen };
      expect(Object.isFrozen(cloned)).toBe(false);
      cloned.age = 30;
      expect(cloned).toEqual({ name: "Alice", age: 30 });
    });
  });
});
