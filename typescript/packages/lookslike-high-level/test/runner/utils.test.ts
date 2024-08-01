import { describe, it, expect } from "vitest";
import {
  extractDefaultValues,
  mergeObjects,
  sendValueToBinding,
  mapBindingsToCell,
} from "../../src/runner/runner.js";
import { cell } from "../../src/runner/cell.js";

describe("extractDefaultValues", () => {
  it("should extract default values from a schema", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string", default: "John" },
        age: { type: "number", default: 30 },
        address: {
          type: "object",
          properties: {
            street: { type: "string", default: "Main St" },
            city: { type: "string", default: "New York" },
          },
        },
      },
    };

    const result = extractDefaultValues(schema);
    expect(result).toEqual({
      name: "John",
      age: 30,
      address: {
        street: "Main St",
        city: "New York",
      },
    });
  });
});

describe("mergeObjects", () => {
  it("should merge multiple objects", () => {
    const obj1 = { a: 1, b: { x: 10 } };
    const obj2 = { b: { y: 20 }, c: 3 };
    const obj3 = { a: 4, d: 5 };

    const result = mergeObjects(obj1, obj2, obj3);
    expect(result).toEqual({
      a: 1,
      b: { x: 10, y: 20 },
      c: 3,
      d: 5,
    });
  });

  it("should handle undefined values", () => {
    const obj1 = { a: 1 };
    const obj2 = undefined;
    const obj3 = { b: 2 };

    const result = mergeObjects(obj1, obj2, obj3);
    expect(result).toEqual({ a: 1, b: 2 });
  });
});

describe("sendValueToBinding", () => {
  it("should send value to a simple binding", () => {
    const testCell = cell({ value: 0 });
    sendValueToBinding(testCell, { $alias: { path: ["value"] } }, 42);
    expect(testCell.get()).toEqual({ value: 42 });
  });

  it("should handle array bindings", () => {
    const testCell = cell({ arr: [0, 0, 0] });
    sendValueToBinding(
      testCell,
      [{ $alias: { path: ["arr", 0] } }, { $alias: { path: ["arr", 2] } }],
      [1, 3]
    );
    expect(testCell.get()).toEqual({ arr: [1, 0, 3] });
  });

  it("should handle bindings with multiple levels", () => {
    const testCell = cell({
      user: {
        name: {
          first: "John",
          last: "Doe",
        },
        age: 30,
      },
    });

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

    expect(testCell.get()).toEqual({
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
    const testCell = cell({ a: 1, b: { c: 2 } });
    const binding = {
      x: { $alias: { path: ["a"] } },
      y: { $alias: { path: ["b", "c"] } },
      z: 3,
    };

    const result = mapBindingsToCell(binding, testCell);
    expect(result).toEqual({
      x: { $alias: { cell: testCell, path: ["a"] } },
      y: { $alias: { cell: testCell, path: ["b", "c"] } },
      z: 3,
    });
  });
});
