import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  sendValueToBinding,
  unwrapOneLevelAndBindtoDoc,
} from "../src/recipe-binding.ts";
import { Runtime } from "../src/runtime.ts";

describe("recipe-binding", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = new Runtime({
      storageUrl: "volatile://",
    });
  });

  afterEach(() => {
    return runtime.dispose();
  });

  describe("sendValueToBinding", () => {
    it("should send value to a simple binding", () => {
      const testCell = runtime.documentMap.getDoc(
        { value: 0 },
        "should send value to a simple binding 1",
        "test",
      );
      sendValueToBinding(testCell, { $alias: { path: ["value"] } }, 42);
      expect(testCell.getAsQueryResult()).toEqual({ value: 42 });
    });

    it("should handle array bindings", () => {
      const testCell = runtime.documentMap.getDoc(
        { arr: [0, 0, 0] },
        "should handle array bindings 1",
        "test",
      );
      sendValueToBinding(
        testCell,
        [{ $alias: { path: ["arr", 0] } }, { $alias: { path: ["arr", 2] } }],
        [1, 3],
      );
      expect(testCell.getAsQueryResult()).toEqual({ arr: [1, 0, 3] });
    });

    it("should handle bindings with multiple levels", () => {
      const testCell = runtime.documentMap.getDoc(
        {
          user: {
            name: {
              first: "John",
              last: "Doe",
            },
            age: 30,
          },
        },
        "should handle bindings with multiple levels 1",
        "test",
      );

      const binding = {
        person: {
          fullName: {
            firstName: { $alias: { path: ["user", "name", "first"] } },
            lastName: { $alias: { path: ["user", "name", "last"] } },
          },
          currentAge: { $alias: { path: ["user", "age"] } },
        },
      };

      const value = {
        person: {
          fullName: {
            firstName: "Jane",
            lastName: "Smith",
          },
          currentAge: 25,
        },
      };

      sendValueToBinding(testCell, binding, value);

      expect(testCell.getAsQueryResult()).toEqual({
        user: {
          name: {
            first: "Jane",
            last: "Smith",
          },
          age: 25,
        },
      });
    });
  });

  describe("mapBindingToCell", () => {
    it("should map bindings to cell aliases", () => {
      const testCell = runtime.documentMap.getDoc(
        { a: 1, b: { c: 2 } },
        "should map bindings to cell aliases 1",
        "test",
      );
      const binding = {
        x: { $alias: { path: ["a"] } },
        y: { $alias: { path: ["b", "c"] } },
        z: 3,
      };

      const result = unwrapOneLevelAndBindtoDoc(binding, testCell);
      expect(result).toEqual({
        x: { $alias: { cell: testCell, path: ["a"] } },
        y: { $alias: { cell: testCell, path: ["b", "c"] } },
        z: 3,
      });
    });
  });
});