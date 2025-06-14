import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { followAliases } from "../src/link-resolution.ts";
import { Runtime } from "../src/runtime.ts";

describe("link-resolution", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = new Runtime({
      storageUrl: "volatile://",
    });
  });

  afterEach(() => {
    return runtime.dispose();
  });

  describe("followAliases", () => {
    it("should follow a simple alias", () => {
      const testCell = runtime.documentMap.getDoc(
        { value: 42 },
        "should follow a simple alias 1",
        "test",
      );
      const binding = { $alias: { path: ["value"] } };
      const result = followAliases(binding, testCell);
      expect(result.cell.getAtPath(result.path)).toBe(42);
    });

    it("should follow nested aliases", () => {
      const innerCell = runtime.documentMap.getDoc(
        { inner: 10 },
        "should follow nested aliases 1",
        "test",
      );
      const outerCell = runtime.documentMap.getDoc(
        {
          outer: { $alias: { cell: innerCell, path: ["inner"] } },
        },
        "should follow nested aliases 2",
        "test",
      );
      const binding = { $alias: { path: ["outer"] } };
      const result = followAliases(binding, outerCell);
      expect(result.cell).toEqual(innerCell);
      expect(result.path).toEqual(["inner"]);
      expect(result.cell.getAtPath(result.path)).toBe(10);
    });

    it("should throw an error on circular aliases", () => {
      const cellA = runtime.documentMap.getDoc(
        {},
        "should throw an error on circular aliases 1",
        "test",
      );
      const cellB = runtime.documentMap.getDoc(
        {},
        "should throw an error on circular aliases 2",
        "test",
      );
      cellA.send({ alias: { $alias: { cell: cellB, path: ["alias"] } } });
      cellB.send({ alias: { $alias: { cell: cellA, path: ["alias"] } } });
      const binding = { $alias: { path: ["alias"] } };
      expect(() => followAliases(binding, cellA)).toThrow("cycle detected");
    });

    it("should allow aliases in aliased paths", () => {
      const testCell = runtime.documentMap.getDoc(
        {
          a: { a: { $alias: { path: ["a", "b"] } }, b: { c: 1 } },
        },
        "should allow aliases in aliased paths 1",
        "test",
      );
      const binding = { $alias: { path: ["a", "a", "c"] } };
      const result = followAliases(binding, testCell);
      expect(result.cell).toEqual(testCell);
      expect(result.path).toEqual(["a", "b", "c"]);
      expect(result.cell.getAtPath(result.path)).toBe(1);
    });
  });
});