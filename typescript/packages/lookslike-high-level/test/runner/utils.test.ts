import { describe, it, expect } from "vitest";
import {
  //runRecipe,
  extractDefaultValues,
  mergeObjects,
  sendValueToBinding,
  mapBindingToCellReferences,
} from "../../src/runner/runner.js";
import { cell } from "../../src/runner/cell.js";
//import { cell } from "../../src/builder/index.js";

/*describe.skip("runRecipe", () => {
  it("should run a simple recipe", () => {
    const mockRecipe: Recipe = {
      schema: {},
      initial: { value: 1 },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (cell) => cell.value.set(cell.value.get() * 2),
          },
          inputs: {},
          outputs: {},
        },
      ],
    };

    const result = runRecipe(mockRecipe, {});
    expect(result.export().value).toEqual({ value: 2 });
  });

  it("should handle nested recipes", () => {
    const nestedRecipe: Recipe = {
      schema: {},
      initial: { value: 2 },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (cell) => cell.value.set(cell.value.get() * 2),
          },
          inputs: {},
          outputs: {},
        },
      ],
    };

    const mockRecipe: Recipe = {
      schema: {},
      initial: { value: 1 },
      nodes: [
        {
          module: { type: "recipe", implementation: nestedRecipe },
          inputs: { value: { $ref: ["value"] } },
          outputs: { value: { $ref: ["value"] } },
        },
      ],
    };

    const result = runRecipe(mockRecipe, {});
    expect(result.export().value).toEqual({ value: 4 });
  });
});*/

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
    sendValueToBinding(testCell, { $ref: ["value"] }, 42);
    expect(testCell.get()).toEqual({ value: 42 });
  });

  it("should handle array bindings", () => {
    const testCell = cell({ arr: [0, 0, 0] });
    sendValueToBinding(
      testCell,
      [{ $ref: ["arr", 0] }, { $ref: ["arr", 2] }],
      [1, 3]
    );
    expect(testCell.get()).toEqual({ arr: [1, 0, 3] });
  });
});

describe("mapBindingToCellReferences", () => {
  it("should map bindings to cell references", () => {
    const testCell = cell({ a: 1, b: { c: 2 } });
    const binding = {
      x: { $ref: ["a"] },
      y: { $ref: ["b", "c"] },
      z: 3,
    };

    const result = mapBindingToCellReferences(binding, testCell);
    expect(result).toEqual({
      x: { cell: testCell, path: ["a"] },
      y: { cell: testCell, path: ["b", "c"] },
      z: 3,
    });
  });
});
