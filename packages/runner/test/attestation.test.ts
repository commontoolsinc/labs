import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { assert, unclaimed } from "@commontools/memory/fact";
import * as Attestation from "../src/storage/transaction/attestation.ts";

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
      expect(result.error?.name).toBe("StorageTransactionInconsistent");
      expect(result.error?.message).toContain("cannot write");
      expect(result.error?.message).toContain("expected an object");
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
      expect(result.error?.name).toBe("StorageTransactionInconsistent");
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
      expect(result.error?.name).toBe("StorageTransactionInconsistent");
      expect(result.error?.message).toContain("cannot read");
      expect(result.error?.message).toContain("encountered: 42");
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
      expect(result.error?.name).toBe("StorageTransactionInconsistent");
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

    it("should return undefined for array.length access", () => {
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
      expect(result.ok?.value).toBeUndefined();
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
      expect(result.error?.name).toBe("StorageTransactionInconsistent");
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
      expect(result.error?.name).toBe("StorageTransactionInconsistent");
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

        const error = new Attestation.NotFound(source, address);

        expect(error.name).toBe("NotFoundError");
        expect(error.message).toContain(
          'Can not resolve the "application/json" of "test:1"',
        );
        expect(error.message).toContain("data.property");
        expect(error.message).toContain("non-object at data");
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

        const error = new Attestation.NotFound(source, address);
        const withSpace = error.from(space);

        expect(withSpace.space).toBe(space);
        expect(withSpace.message).toContain(`from "${space}"`);
      });
    });

    describe("WriteInconsistency", () => {
      it("should create descriptive error message", () => {
        const source = {
          address: { id: "test:1", type: "application/json", path: ["data"] },
          value: 42,
        } as const;
        const address = {
          id: "test:1",
          type: "application/json",
          path: ["data", "property"],
        } as const;

        const error = new Attestation.WriteInconsistency(source, address);

        expect(error.name).toBe("StorageTransactionInconsistent");
        expect(error.message).toContain("cannot write");
        expect(error.message).toContain("data.property");
        expect(error.message).toContain("expected an object");
        expect(error.message).toContain("encountered: 42");
      });

      it("should support space context", () => {
        const source = {
          address: { id: "test:1", type: "application/json", path: [] },
          value: "string",
        } as const;
        const address = {
          id: "test:1",
          type: "application/json",
          path: ["property"],
        } as const;

        const error = new Attestation.WriteInconsistency(source, address);
        const withSpace = error.from(space);

        expect(withSpace.space).toBe(space);
        expect(withSpace.message).toContain(`in space "${space}"`);
      });
    });

    describe("ReadInconsistency", () => {
      it("should create descriptive error message", () => {
        const source = {
          address: { id: "test:1", type: "application/json", path: ["user"] },
          value: null,
        } as const;
        const address = {
          id: "test:1",
          type: "application/json",
          path: ["user", "name"],
        } as const;

        const error = new Attestation.ReadInconsistency(source, address);

        expect(error.name).toBe("StorageTransactionInconsistent");
        expect(error.message).toContain("cannot read");
        expect(error.message).toContain("user.name");
        expect(error.message).toContain("expected an object");
        expect(error.message).toContain("encountered: null");
      });
    });

    describe("StateInconsistency", () => {
      it("should create descriptive error message", () => {
        const error = new Attestation.StateInconsistency({
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
        const error = new Attestation.StateInconsistency({
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
        const error = new Attestation.StateInconsistency({
          address: { id: "test:1", type: "application/json", path: [] },
          expected: "old",
          actual: "new",
        });

        const withSpace = error.from(space);
        expect(withSpace.source.space).toBe(space);
        expect(withSpace.message).toContain(`in space "${space}"`);
      });
    });
  });
});
