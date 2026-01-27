import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { assert, unclaimed } from "@commontools/memory/fact";
import * as Attestation from "../src/storage/transaction/attestation.ts";
import type { INotFoundError } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("attestation test");
const space = signer.did();

describe("Attestation Module", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let replica: any;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    replica = storage.open(space).replica;
  });

  afterEach(async () => {
    await storage?.close();
  });

  describe("write function", () => {
    it("should write to root path (empty path)", () => {
      const source = {
        address: { id: "test:1", type: "application/json", path: [] },
        value: { name: "Alice" },
      } as const;

      const result = Attestation.write(source, source.address, { name: "Bob" });

      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toEqual({ name: "Bob" });
      expect(result.ok?.address).toEqual(source.address);
    });

    it("should write to nested path", () => {
      const source = {
        address: { id: "test:2", type: "application/json", path: [] },
        value: { user: { name: "Alice", age: 30 } },
      } as const;

      const result = Attestation.write(source, {
        id: "test:2",
        type: "application/json",
        path: ["user", "name"],
      }, "Bob");

      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toEqual({ user: { name: "Bob", age: 30 } });
    });

    it("should create new nested properties", () => {
      const source = {
        address: { id: "test:3", type: "application/json", path: [] },
        value: { user: {} },
      } as const;

      const result = Attestation.write(source, {
        id: "test:3",
        type: "application/json",
        path: ["user", "settings"],
      }, { theme: "dark" });

      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toEqual({
        user: { settings: { theme: "dark" } },
      });
    });

    it("should delete properties with undefined value", () => {
      const source = {
        address: { id: "test:4", type: "application/json", path: [] },
        value: { name: "Alice", age: 30, active: true },
      } as const;

      const result = Attestation.write(source, {
        id: "test:4",
        type: "application/json",
        path: ["age"],
      }, undefined);

      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toEqual({ name: "Alice", active: true });
    });

    it("should return original source when value is unchanged", () => {
      const source = {
        address: { id: "test:5", type: "application/json", path: [] },
        value: { name: "Alice", age: 30 },
      } as const;

      const result = Attestation.write(source, {
        id: "test:5",
        type: "application/json",
        path: ["name"],
      }, "Alice");

      expect(result.ok).toBe(source);
    });

    it("should fail when writing to non-object", () => {
      const source = {
        address: { id: "test:6", type: "application/json", path: [] },
        value: "not an object",
      } as const;

      const result = Attestation.write(source, {
        id: "test:6",
        type: "application/json",
        path: ["property"],
      }, "value");

      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("TypeMismatchError");
      expect(result.error?.message).toContain("Cannot write property");
      expect(result.error?.message).toContain(
        "expected object but found string",
      );
    });

    it("should fail when path leads through primitive", () => {
      const source = {
        address: { id: "test:7", type: "application/json", path: [] },
        value: {
          user: {
            name: "Alice",
            settings: "disabled", // String, not object
          },
        },
      } as const;

      const result = Attestation.write(source, {
        id: "test:7",
        type: "application/json",
        path: ["user", "settings", "notifications"],
      }, true);

      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("TypeMismatchError");
    });

    it("should handle array modifications", () => {
      const source = {
        address: { id: "test:8", type: "application/json", path: [] },
        value: { items: ["a", "b", "c"] },
      } as const;

      const result = Attestation.write(source, {
        id: "test:8",
        type: "application/json",
        path: ["items", "1"],
      }, "modified");

      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toEqual({ items: ["a", "modified", "c"] });
    });

    it("should allow writing to array with index 0", () => {
      const source = {
        address: { id: "test:array-0", type: "application/json", path: [] },
        value: { items: ["first", "second", "third"] },
      } as const;

      const result = Attestation.write(source, {
        id: "test:array-0",
        type: "application/json",
        path: ["items", "0"],
      }, "replaced");

      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toEqual({
        items: ["replaced", "second", "third"],
      });
    });

    it("should allow writing to array 'length' property", () => {
      const source = {
        address: {
          id: "test:array-length",
          type: "application/json",
          path: [],
        },
        value: { items: ["a", "b", "c", "d", "e"] },
      } as const;

      const result = Attestation.write(source, {
        id: "test:array-length",
        type: "application/json",
        path: ["items", "length"],
      }, 3);

      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toEqual({ items: ["a", "b", "c"] });
    });

    it("should fail when writing to array with negative index", () => {
      const source = {
        address: {
          id: "test:array-negative",
          type: "application/json",
          path: [],
        },
        value: { items: ["a", "b", "c"] },
      } as const;

      const result = Attestation.write(source, {
        id: "test:array-negative",
        type: "application/json",
        path: ["items", "-1"],
      }, "value");

      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("TypeMismatchError");
      expect(result.error?.message).toContain("Cannot write property");
      expect(result.error?.message).toContain(
        "expected object but found array",
      );
    });

    it("should fail when writing to array with non-integer numeric key", () => {
      const source = {
        address: { id: "test:array-float", type: "application/json", path: [] },
        value: { items: ["a", "b", "c"] },
      } as const;

      const result = Attestation.write(source, {
        id: "test:array-float",
        type: "application/json",
        path: ["items", "1.5"],
      }, "value");

      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("TypeMismatchError");
      expect(result.error?.message).toContain("Cannot write property");
      expect(result.error?.message).toContain(
        "expected object but found array",
      );
    });

    it("should fail when writing to array with leading-zero key", () => {
      const source = {
        address: {
          id: "test:array-leading-zero",
          type: "application/json",
          path: [],
        },
        value: { items: ["a", "b", "c"] },
      } as const;

      // "01" looks numeric but is not a valid array index (leading zero)
      const result = Attestation.write(source, {
        id: "test:array-leading-zero",
        type: "application/json",
        path: ["items", "01"],
      }, "value");

      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("TypeMismatchError");
      expect(result.error?.message).toContain("Cannot write property");
      expect(result.error?.message).toContain(
        "expected object but found array",
      );
    });

    it("should fail when writing to array with index >= 2**31", () => {
      const source = {
        address: {
          id: "test:array-huge-index",
          type: "application/json",
          path: [],
        },
        value: { items: ["a", "b", "c"] },
      } as const;

      // 4294967296 is 2**32, which exceeds the valid array index range
      const result = Attestation.write(source, {
        id: "test:array-huge-index",
        type: "application/json",
        path: ["items", "4294967296"],
      }, "value");

      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("TypeMismatchError");
      expect(result.error?.message).toContain("Cannot write property");
      expect(result.error?.message).toContain(
        "expected object but found array",
      );
    });

    it("should fail when writing to array with string key (not 'length')", () => {
      const source = {
        address: {
          id: "test:array-string",
          type: "application/json",
          path: [],
        },
        value: { items: ["a", "b", "c"] },
      } as const;

      const result = Attestation.write(source, {
        id: "test:array-string",
        type: "application/json",
        path: ["items", "someProperty"],
      }, "value");

      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("TypeMismatchError");
      expect(result.error?.message).toContain("Cannot write property");
      expect(result.error?.message).toContain(
        "expected object but found array",
      );
    });

    it("should handle writing to large array indices", () => {
      const source = {
        address: { id: "test:array-large", type: "application/json", path: [] },
        value: { items: ["a", "b", "c"] },
      } as const;

      const result = Attestation.write(source, {
        id: "test:array-large",
        type: "application/json",
        path: ["items", "10"],
      }, "sparse");

      expect(result.ok).toBeDefined();
      const resultValue = result.ok?.value as { items: any[] };
      expect(resultValue.items[10]).toBe("sparse");
      expect(resultValue.items.length).toBe(11);
      expect(resultValue.items[3]).toBeUndefined();
      expect(resultValue.items[9]).toBeUndefined();
    });

    it("should share sibling references (structural sharing)", () => {
      // CT-1123 Phase 2: Verify structural sharing optimization
      const source = {
        address: { id: "test:structural", type: "application/json", path: [] },
        value: {
          unchanged: { nested: { deep: "value" } },
          modified: { target: "old" },
        },
      } as const;

      const result = Attestation.write(source, {
        id: "test:structural",
        type: "application/json",
        path: ["modified", "target"],
      }, "new");

      expect(result.ok).toBeDefined();
      const resultValue = result.ok!.value as Record<string, unknown>;

      // Modified path should have new value
      expect((resultValue.modified as Record<string, unknown>).target).toBe(
        "new",
      );

      // Sibling 'unchanged' should be EXACT SAME reference (structural sharing)
      expect(resultValue.unchanged).toBe(source.value.unchanged);

      // Modified 'modified' object should be NEW reference
      expect(resultValue.modified).not.toBe(source.value.modified);

      // Original source should be unmodified
      expect(source.value.modified.target).toBe("old");
    });

    it("should set NotFoundError.path to last valid parent for writes to non-existent nested path", () => {
      // Source has { user: { name: "Alice" } } - no "settings" key
      const source = {
        address: {
          id: "test:notfound-path",
          type: "application/json",
          path: [],
        },
        value: { user: { name: "Alice" } },
      } as const;

      // Try to write to ["user", "settings", "theme"] - "settings" doesn't exist
      const result = Attestation.write(source, {
        id: "test:notfound-path",
        type: "application/json",
        path: ["user", "settings", "theme"],
      }, "dark");

      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("NotFoundError");
      // The path includes the non-existent key: ["user", "settings"]
      // (consistent with read error semantics)
      expect((result.error as INotFoundError).path).toEqual([
        "user",
        "settings",
      ]);
    });

    it("should set NotFoundError.path to empty array when document does not exist (write)", () => {
      // Document doesn't exist at all (value is undefined at root)
      const source = {
        address: {
          id: "test:doc-not-found-write",
          type: "application/json",
          path: [],
        },
        value: undefined,
      } as const;

      // Try to write a nested path on non-existent document
      const result = Attestation.write(source, {
        id: "test:doc-not-found-write",
        type: "application/json",
        path: ["foo", "bar"],
      }, "value");

      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("NotFoundError");
      // When document doesn't exist, path is [] (consistent with reads)
      expect((result.error as INotFoundError).path).toEqual([]);
    });
  });

  describe("setAtPath edge cases", () => {
    // 1. PROTOTYPE POLLUTION
    it("should not allow __proto__ key writes to pollute Object.prototype", () => {
      const source = {
        address: { id: "test:proto", type: "application/json", path: [] },
        value: { safe: 1 },
      } as const;
      // Attempt to pollute via __proto__
      Attestation.write(
        source,
        { ...source.address, path: ["__proto__", "polluted"] },
        true,
      );
      // Verify Object.prototype wasn't polluted
      // deno-lint-ignore no-explicit-any
      expect(({} as any).polluted).toBeUndefined();
    });

    it("should not allow constructor key writes to pollute prototypes", () => {
      const source = {
        address: { id: "test:constructor", type: "application/json", path: [] },
        value: { data: {} },
      } as const;
      Attestation.write(
        source,
        {
          ...source.address,
          path: ["data", "constructor", "prototype", "polluted"],
        },
        true,
      );
      // deno-lint-ignore no-explicit-any
      expect(({} as any).polluted).toBeUndefined();
    });

    // 2. NaN HANDLING
    it("should handle NaN values (NaN === NaN is false)", () => {
      const source = {
        address: {
          id: "test:nan" as const,
          type: "application/json" as const,
          path: [] as const,
        },
        value: { x: NaN },
      };
      // Writing NaN to a field that already has NaN
      const result = Attestation.write(
        source,
        { ...source.address, path: ["x"] },
        NaN,
      );
      // Document current behavior: NaN !== NaN, so this won't be noop
      expect(result.ok).toBeDefined();
      expect(Number.isNaN((result.ok!.value as { x: number }).x)).toBe(true);
    });

    it("should handle -0 vs 0 comparison (should be noop)", () => {
      const source = {
        address: {
          id: "test:zero" as const,
          type: "application/json" as const,
          path: [] as const,
        },
        value: { x: -0 },
      };
      const result = Attestation.write(
        source,
        { ...source.address, path: ["x"] },
        0,
      );
      // -0 === 0 is true, so this should be noop
      expect(result.ok).toBe(source);
    });

    // 3. ARRAY.LENGTH EDGE CASES
    it("should handle negative array length (slice behavior removes last element)", () => {
      const source = {
        address: {
          id: "test:arrlen" as const,
          type: "application/json" as const,
          path: [] as const,
        },
        value: { items: [1, 2, 3] },
      };
      const result = Attestation.write(
        source,
        { ...source.address, path: ["items", "length"] },
        -1,
      );
      // Document current behavior: slice(0, -1) returns all but last
      expect(result.ok).toBeDefined();
      // deno-lint-ignore no-explicit-any
      const items = (result.ok!.value as any).items;
      expect(items).toEqual([1, 2]); // slice(0, -1) behavior
    });

    it("should handle NaN as array length (produces empty array)", () => {
      const source = {
        address: {
          id: "test:arrnan" as const,
          type: "application/json" as const,
          path: [] as const,
        },
        value: { items: [1, 2, 3] },
      };
      const result = Attestation.write(
        source,
        { ...source.address, path: ["items", "length"] },
        NaN,
      );
      // slice(0, NaN) returns empty array
      expect(result.ok).toBeDefined();
      // deno-lint-ignore no-explicit-any
      expect((result.ok!.value as any).items).toEqual([]);
    });

    // 4. LARGE ARRAY INDEX
    it("should handle large array indices as sparse arrays", () => {
      const source = {
        address: {
          id: "test:bigidx" as const,
          type: "application/json" as const,
          path: [] as const,
        },
        // deno-lint-ignore no-explicit-any
        value: { items: [] as any[] },
      };
      const result = Attestation.write(
        source,
        { ...source.address, path: ["items", "1000000"] },
        "value",
      );
      expect(result.ok).toBeDefined();
      // deno-lint-ignore no-explicit-any
      const items = (result.ok!.value as any).items;
      // Should be sparse array, not allocating 1M elements
      expect(Object.keys(items).length).toBe(1);
      expect(items[1000000]).toBe("value");
      expect(items.length).toBe(1000001); // length is set
    });

    // 5. SPARSE ARRAY BEHAVIOR
    it("should convert sparse array holes to undefined (spread behavior)", () => {
      // Create sparse array using explicit assignment
      // deno-lint-ignore no-explicit-any
      const sparseArray: any[] = [];
      sparseArray[0] = 1;
      sparseArray[2] = 3;
      // Index 1 is a hole (not undefined, actually missing)

      const source = {
        address: {
          id: "test:sparse" as const,
          type: "application/json" as const,
          path: [] as const,
        },
        value: { items: sparseArray },
      };
      const result = Attestation.write(
        source,
        { ...source.address, path: ["items", "0"] },
        999,
      );
      expect(result.ok).toBeDefined();
      // deno-lint-ignore no-explicit-any
      const items = (result.ok!.value as any).items;
      expect(items[0]).toBe(999);
      // NOTE: [...array] spread converts holes to undefined (1 in items is now true)
      // Old JSON.parse(JSON.stringify()) would convert holes to null
      // This is a known behavioral difference, but both result in "filled" arrays
      expect(1 in items).toBe(true); // hole is converted to undefined
      expect(items[1]).toBe(undefined);
      expect(items[2]).toBe(3);
    });
  });

  describe("read function", () => {
    it("should read from root path", () => {
      const source = {
        address: { id: "test:1", type: "application/json", path: [] },
        value: { name: "Alice", age: 30 },
      } as const;

      const result = Attestation.read(source, source.address);

      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toEqual({ name: "Alice", age: 30 });
      expect(result.ok?.address).toEqual(source.address);
    });

    it("should read nested properties", () => {
      const source = {
        address: { id: "test:2", type: "application/json", path: [] },
        value: { user: { name: "Alice", settings: { theme: "dark" } } },
      } as const;

      const result = Attestation.read(source, {
        id: "test:2",
        type: "application/json",
        path: ["user", "name"],
      });

      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toBe("Alice");
    });

    it("should read deeply nested properties", () => {
      const source = {
        address: { id: "test:3", type: "application/json", path: [] },
        value: { user: { settings: { theme: "dark", notifications: true } } },
      } as const;

      const result = Attestation.read(source, {
        id: "test:3",
        type: "application/json",
        path: ["user", "settings", "theme"],
      });

      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toBe("dark");
    });

    it("should return undefined for non-existent properties", () => {
      const source = {
        address: { id: "test:4", type: "application/json", path: [] },
        value: { name: "Alice" },
      } as const;

      const result = Attestation.read(source, {
        id: "test:4",
        type: "application/json",
        path: ["age"],
      });

      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toBeUndefined();
    });

    it("should fail when reading through primitive", () => {
      const source = {
        address: { id: "test:5", type: "application/json", path: [] },
        value: 42,
      } as const;

      const result = Attestation.read(source, {
        id: "test:5",
        type: "application/json",
        path: ["property"],
      });

      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("TypeMismatchError");
      expect(result.error?.message).toContain("Cannot read property");
      expect(result.error?.message).toContain(
        "expected object but found number",
      );
    });

    it("should fail when reading through null", () => {
      const source = {
        address: { id: "test:6", type: "application/json", path: [] },
        value: { data: null },
      } as const;

      const result = Attestation.read(source, {
        id: "test:6",
        type: "application/json",
        path: ["data", "property"],
      });

      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("TypeMismatchError");
    });

    it("should handle array access", () => {
      const source = {
        address: { id: "test:7", type: "application/json", path: [] },
        value: { items: ["first", "second", "third"] },
      } as const;

      const result = Attestation.read(source, {
        id: "test:7",
        type: "application/json",
        path: ["items", "1"],
      });

      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toBe("second");
    });

    it("should return array length for array.length access", () => {
      const source = {
        address: { id: "test:8", type: "application/json", path: [] },
        value: { items: ["a", "b", "c"] },
      } as const;

      const result = Attestation.read(source, {
        id: "test:8",
        type: "application/json",
        path: ["items", "length"],
      });

      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toBe(3);
    });

    it("should read from undefined source", () => {
      const source = {
        address: { id: "test:9", type: "application/json", path: [] },
        value: undefined,
      } as const;

      const result = Attestation.read(source, source.address);

      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toBeUndefined();
    });

    it("should fail reading nested from undefined source", () => {
      const source = {
        address: { id: "test:10", type: "application/json", path: [] },
        value: undefined,
      } as const;

      const result = Attestation.read(source, {
        id: "test:10",
        type: "application/json",
        path: ["property"],
      });

      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("NotFoundError");
    });

    it("should set NotFoundError.path to empty array when document does not exist (read)", () => {
      // Document doesn't exist at all (value is undefined at root)
      const source = {
        address: {
          id: "test:doc-not-found-read",
          type: "application/json",
          path: [],
        },
        value: undefined,
      } as const;

      // Try to read a nested path on non-existent document
      const result = Attestation.read(source, {
        id: "test:doc-not-found-read",
        type: "application/json",
        path: ["foo", "bar"],
      });

      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("NotFoundError");
      // When document doesn't exist, path is [] (consistent with writes)
      expect((result.error as INotFoundError).path).toEqual([]);
    });

    it("should set NotFoundError.path to path of non-existent key for reads", () => {
      // Source has { user: { name: "Alice" } } - no "settings" key
      const source = {
        address: {
          id: "test:notfound-read-path",
          type: "application/json",
          path: [],
        },
        value: { user: { name: "Alice" } },
      } as const;

      // Try to read ["user", "settings", "theme"] - "settings" doesn't exist
      const result = Attestation.read(source, {
        id: "test:notfound-read-path",
        type: "application/json",
        path: ["user", "settings", "theme"],
      });

      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("NotFoundError");
      // The path includes the non-existent key: ["user", "settings"]
      expect((result.error as INotFoundError).path).toEqual([
        "user",
        "settings",
      ]);
    });
  });

  describe("attest function", () => {
    it("should create attestation from state", () => {
      const state = {
        the: "application/json",
        of: "test:1",
        is: { name: "Alice", age: 30 },
      } as const;

      const result = Attestation.attest(state);

      expect(result).toEqual({
        address: { id: "test:1", type: "application/json", path: [] },
        value: { name: "Alice", age: 30 },
      });
    });

    it("should create attestation from unclaimed state", () => {
      const state = unclaimed({ the: "application/json", of: "test:2" });

      const result = Attestation.attest(state);

      expect(result).toEqual({
        address: { id: "test:2", type: "application/json", path: [] },
        value: undefined,
      });
    });
  });

  describe("claim function", () => {
    it("should succeed when attestation matches replica state", async () => {
      const testData = { name: "Charlie", version: 1 };
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "test:claim",
            is: testData,
          }),
        ],
        claims: [],
      });

      const attestation = {
        address: { id: "test:claim", type: "application/json", path: [] },
        value: testData,
      } as const;

      const result = Attestation.claim(attestation, replica);

      expect(result.ok).toBeDefined();
      expect(result.ok?.the).toBe("application/json");
      expect(result.ok?.of).toBe("test:claim");
      expect(result.ok?.is).toEqual(testData);
    });

    it("should succeed when claiming unclaimed state", () => {
      const attestation = {
        address: { id: "test:unclaimed", type: "application/json", path: [] },
        value: undefined,
      } as const;

      const result = Attestation.claim(attestation, replica);

      expect(result.ok).toBeDefined();
      expect(result.ok?.is).toBeUndefined();
    });

    it("should fail when attestation doesn't match replica state", async () => {
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "test:mismatch",
            is: { name: "Alice", version: 1 },
          }),
        ],
        claims: [],
      });

      const attestation = {
        address: { id: "test:mismatch", type: "application/json", path: [] },
        value: { name: "Bob", version: 2 },
      } as const;

      const result = Attestation.claim(attestation, replica);

      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("StorageTransactionInconsistent");
      expect(result.error?.message).toContain("hash changed");
    });

    it("should validate nested paths", async () => {
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "test:nested-claim",
            is: { user: { name: "Alice", settings: { theme: "light" } } },
          }),
        ],
        claims: [],
      });

      const attestation = {
        address: {
          id: "test:nested-claim",
          type: "application/json",
          path: ["user", "settings", "theme"],
        },
        value: "light",
      } as const;

      const result = Attestation.claim(attestation, replica);

      expect(result.ok).toBeDefined();
    });

    it("should fail when nested path doesn't match", async () => {
      await replica.commit({
        facts: [
          assert({
            the: "application/json",
            of: "test:nested-fail",
            is: { user: { name: "Alice", settings: { theme: "light" } } },
          }),
        ],
        claims: [],
      });

      const attestation = {
        address: {
          id: "test:nested-fail",
          type: "application/json",
          path: ["user", "settings", "theme"],
        },
        value: "dark",
      } as const;

      const result = Attestation.claim(attestation, replica);

      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("StorageTransactionInconsistent");
    });
  });

  describe("resolve function", () => {
    it("should resolve root address", () => {
      const source = {
        address: { id: "test:1", type: "application/json", path: [] },
        value: { name: "Alice" },
      } as const;

      const result = Attestation.resolve(source, source.address);

      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toEqual({ name: "Alice" });
      expect(result.ok?.address).toEqual(source.address);
    });

    it("should resolve nested paths", () => {
      const source = {
        address: { id: "test:2", type: "application/json", path: [] },
        value: { user: { profile: { name: "Alice", age: 30 } } },
      } as const;

      const result = Attestation.resolve(source, {
        id: "test:2",
        type: "application/json",
        path: ["user", "profile"],
      });

      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toEqual({ name: "Alice", age: 30 });
    });

    it("should resolve to undefined for missing properties", () => {
      const source = {
        address: { id: "test:3", type: "application/json", path: [] },
        value: { user: {} },
      } as const;

      const result = Attestation.resolve(source, {
        id: "test:3",
        type: "application/json",
        path: ["user", "missing"],
      });

      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toBeUndefined();
    });

    it("should fail when resolving through primitive", () => {
      const source = {
        address: { id: "test:4", type: "application/json", path: [] },
        value: { data: "string" },
      } as const;

      const result = Attestation.resolve(source, {
        id: "test:4",
        type: "application/json",
        path: ["data", "property"],
      });

      expect(result.error).toBeDefined();
      expect(result.error?.name).toBe("TypeMismatchError");
    });

    it("should handle partial source paths", () => {
      const source = {
        address: { id: "test:5", type: "application/json", path: ["user"] },
        value: { name: "Alice", settings: { theme: "dark" } },
      } as const;

      const result = Attestation.resolve(source, {
        id: "test:5",
        type: "application/json",
        path: ["user", "settings", "theme"],
      });

      expect(result.ok).toBeDefined();
      expect(result.ok?.value).toBe("dark");
    });
  });

  describe("Error Classes", () => {
    describe("NotFound", () => {
      it("should create descriptive error message", () => {
        const source = {
          address: { id: "test:1", type: "application/json", path: ["data"] },
          value: "string",
        } as const;
        const address = {
          id: "test:1",
          type: "application/json",
          path: ["data", "property"],
        } as const;

        const error = Attestation.NotFound(source, address, ["data"]);

        expect(error.name).toBe("NotFoundError");
        expect(error.message).toBe(
          "Cannot access path [data, property] - path does not exist",
        );
        expect(error.path).toEqual(["data"]);
        expect(error.source).toBe(source);
        expect(error.address).toBe(address);
      });

      it("should support space context", () => {
        const source = {
          address: { id: "test:1", type: "application/json", path: [] },
          value: null,
        } as const;
        const address = {
          id: "test:1",
          type: "application/json",
          path: ["property"],
        } as const;

        const error = Attestation.NotFound(source, address, []);
        const withSpace = error.from(space);

        // NotFound error now returns the same instance from .from()
        expect(withSpace).toBe(error);
        expect(withSpace.message).toBe(
          "Cannot access path [property] - path does not exist",
        );
        expect(error.path).toEqual([]);
      });
    });

    describe("TypeMismatchError", () => {
      it("should create descriptive error message for write operation", () => {
        const address = {
          id: "test:1",
          type: "application/json",
          path: ["data", "property"],
        } as const;

        const error = Attestation.TypeMismatchError(
          address,
          "number",
          "write",
        );

        expect(error.name).toBe("TypeMismatchError");
        expect(error.message).toContain("Cannot write property");
        expect(error.message).toContain("[data, property]");
        expect(error.message).toContain("expected object but found number");
      });

      it("should create descriptive error message for read operation", () => {
        const address = {
          id: "test:1",
          type: "application/json",
          path: ["user", "name"],
        } as const;

        const error = Attestation.TypeMismatchError(
          address,
          "null",
          "read",
        );

        expect(error.name).toBe("TypeMismatchError");
        expect(error.message).toContain("Cannot read property");
        expect(error.message).toContain("[user, name]");
        expect(error.message).toContain("expected object but found null");
      });
    });

    describe("StateInconsistency", () => {
      it("should create descriptive error message", () => {
        const error = Attestation.StateInconsistency({
          address: {
            id: "test:1",
            type: "application/json",
            path: ["version"],
          },
          expected: 1,
          actual: 2,
        });

        expect(error.name).toBe("StorageTransactionInconsistent");
        expect(error.message).toContain("hash changed");
        expect(error.message).toContain("version");
        expect(error.message).toContain("Previously it used to be:\n 1");
        expect(error.message).toContain("currently it is:\n 2");
        expect(error.address.path).toEqual(["version"]);
      });

      it("should handle undefined values", () => {
        const error = Attestation.StateInconsistency({
          address: { id: "test:1", type: "application/json", path: [] },
          expected: undefined,
          actual: { new: "data" },
        });

        expect(error.message).toContain(
          "Previously it used to be:\n undefined",
        );
        expect(error.message).toContain('currently it is:\n {"new":"data"}');
      });

      it("should support space context", () => {
        const error = Attestation.StateInconsistency({
          address: { id: "test:1", type: "application/json", path: [] },
          expected: "old",
          actual: "new",
        });

        const withSpace = error.from(space);
        expect(withSpace.message).toContain(`in space "${space}"`);
      });
    });

    describe("load function", () => {
      it("should load valid JSON data URI", () => {
        const address = {
          id: 'data:application/json,{"hello":"world"}' as const,
          type: "application/json" as const,
          path: [],
        };

        const result = Attestation.load(address);

        expect(result.ok).toBeDefined();
        expect(result.ok!.address).toEqual(address);
        expect(result.ok!.value).toEqual({ hello: "world" });
      });

      it("should load base64 encoded JSON data URI", () => {
        const address = {
          id: "data:application/json;base64,eyJoZWxsbyI6IndvcmxkIn0=" as const,
          type: "application/json" as const,
          path: [],
        };

        const result = Attestation.load(address);

        expect(result.ok).toBeDefined();
        expect(result.ok!.address).toEqual(address);
        expect(result.ok!.value).toEqual({ hello: "world" });
      });

      it("should load text/plain data URI", () => {
        const address = {
          id: "data:text/plain,hello%20world" as const,
          type: "text/plain" as const,
          path: [],
        };

        const result = Attestation.load(address);

        expect(result.ok).toBeDefined();
        expect(result.ok!.address).toEqual(address);
        expect(result.ok!.value).toBe("hello world");
      });

      it("should load text/plain data URI with base64 encoding", () => {
        const address = {
          id: "data:text/plain;base64,aGVsbG8gd29ybGQ=" as const,
          type: "text/plain" as const,
          path: [],
        };

        const result = Attestation.load(address);

        expect(result.ok).toBeDefined();
        expect(result.ok!.address).toEqual(address);
        expect(result.ok!.value).toBe("hello world");
      });

      it("should handle empty media type (defaults to text/plain)", () => {
        const address = {
          id: "data:,hello%20world" as const,
          type: "text/plain" as const,
          path: [],
        };

        const result = Attestation.load(address);

        expect(result.ok).toBeDefined();
        expect(result.ok!.address).toEqual(address);
        expect(result.ok!.value).toBe("hello world");
      });

      it("should return UnsupportedMediaTypeError for media type mismatch", () => {
        const address = {
          id: "data:text/plain,hello%20world" as const,
          type: "application/json" as const,
          path: [],
        };

        const result = Attestation.load(address);

        expect(result.error).toBeDefined();
        expect(result.error!.name).toBe("UnsupportedMediaTypeError");
        expect(result.error!.message).toContain("Media type mismatch");
        expect(result.error!.message).toContain('expected "application/json"');
        expect(result.error!.message).toContain(
          'but data URI contains "text/plain"',
        );
      });

      it("should return InvalidDataURIError for invalid JSON", () => {
        const address = {
          id: "data:application/json,{invalid-json" as const,
          type: "application/json" as const,
          path: [],
        };

        const result = Attestation.load(address);

        expect(result.error).toBeDefined();
        expect(result.error!.name).toBe("InvalidDataURIError");
        expect(result.error!.message).toContain(
          "Failed to parse JSON from data URI",
        );
      });

      it("should return InvalidDataURIError for malformed data URI", () => {
        const address = {
          id: "data:application/json;no-comma-separator" as const,
          type: "application/json" as const,
          path: [],
        };

        const result = Attestation.load(address);

        expect(result.error).toBeDefined();
        expect(result.error!.name).toBe("InvalidDataURIError");
        expect(result.error!.message).toContain("missing comma separator");
      });

      it("should return InvalidDataURIError for non-data URI", () => {
        const address = {
          id: "http:example.com/data.json" as const,
          type: "application/json" as const,
          path: [],
        };

        const result = Attestation.load(address);

        expect(result.error).toBeDefined();
        expect(result.error!.name).toBe("InvalidDataURIError");
        expect(result.error!.message).toContain("protocol must be 'data:'");
      });

      it("should handle complex JSON objects", () => {
        const jsonData = {
          user: {
            name: "Alice",
            age: 30,
            active: true,
            tags: ["developer", "javascript"],
          },
          metadata: {
            created: "2023-01-01T00:00:00Z",
            version: 1,
          },
        };

        const address = {
          id: `data:application/json,${
            encodeURIComponent(JSON.stringify(jsonData))
          }` as const,
          type: "application/json" as const,
          path: [],
        };

        const result = Attestation.load(address);

        expect(result.ok).toBeDefined();
        expect(result.ok!.address).toEqual(address);
        expect(result.ok!.value).toEqual(jsonData);
      });

      it("should handle additional parameters in data URI", () => {
        const address = {
          id:
            "data:application/json;charset=utf-8;base64,eyJoZWxsbyI6IndvcmxkIn0=" as const,
          type: "application/json" as const,
          path: [],
        };

        const result = Attestation.load(address);

        expect(result.ok).toBeDefined();
        expect(result.ok!.address).toEqual(address);
        expect(result.ok!.value).toEqual({ hello: "world" });
      });

      it("should handle URL-encoded special characters", () => {
        const address = {
          id: "data:text/plain,Hello%20World%21%20%40%23%24%25" as const,
          type: "text/plain" as const,
          path: [],
        };

        const result = Attestation.load(address);

        expect(result.ok).toBeDefined();
        expect(result.ok!.address).toEqual(address);
        expect(result.ok!.value).toBe("Hello World! @#$%");
      });
    });
  });
});
