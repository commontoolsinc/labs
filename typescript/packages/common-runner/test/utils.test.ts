import { describe, it, expect } from "vitest";
import {
  extractDefaultValues,
  mergeObjects,
  sendValueToBinding,
  setNestedValue,
  mapBindingsToCell,
  followCellReferences,
  followAliases,
  compactifyPaths,
} from "../src/utils.js";
import { cell, CellReference, ReactivityLog } from "../src/cell.js";

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

  it("should give precedence to earlier objects in the case of a conflict", () => {
    const obj1 = { a: 1 };
    const obj2 = { a: 2, b: { c: 3 } };
    const obj3 = { a: 3, b: { c: 4 } };

    const result = mergeObjects(obj1, obj2, obj3);
    expect(result).toEqual({ a: 1, b: { c: 3 } });
  });

  it("should treat cell aliases and references as values", () => {
    const testCell = cell();
    const obj1 = { a: { $alias: { path: [] } } };
    const obj2 = { a: 2, b: { c: { cell: testCell, path: [] } } };
    const obj3 = {
      a: { $alias: { cell: testCell, path: ["a"] } },
      b: { c: 4 },
    };

    const result = mergeObjects(obj1, obj2, obj3);
    expect(result).toEqual({
      a: { $alias: { path: [] } },
      b: { c: { cell: testCell, path: [] } },
    });
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

describe("setNestedValue", () => {
  it("should set a value at a path", () => {
    const testCell = cell({ a: 1, b: { c: 2 } });
    const success = setNestedValue(testCell, ["b", "c"], 3);
    expect(success).toBe(true);
    expect(testCell.get()).toEqual({ a: 1, b: { c: 3 } });
  });

  it("should delete no longer used fields when setting a nested value", () => {
    const testCell = cell({ a: 1, b: { c: 2, d: 3 } });
    const success = setNestedValue(testCell, ["b"], { c: 4 });
    expect(success).toBe(true);
    expect(testCell.get()).toEqual({ a: 1, b: { c: 4 } });
  });

  it("should log no changes when setting a nested value that is already set", () => {
    const testCell = cell({ a: 1, b: { c: 2 } });
    const log: ReactivityLog = { reads: [], writes: [] };
    const success = setNestedValue(testCell, [], { a: 1, b: { c: 2 } }, log);
    expect(success).toBe(true); // No changes is still a success
    expect(testCell.get()).toEqual({ a: 1, b: { c: 2 } });
    expect(log.writes).toEqual([]);
  });

  it("should log minimal changes when setting a nested value", () => {
    const testCell = cell({ a: 1, b: { c: 2 } });
    const log: ReactivityLog = { reads: [], writes: [] };
    const success = setNestedValue(testCell, [], { a: 1, b: { c: 3 } }, log);
    expect(success).toBe(true);
    expect(testCell.get()).toEqual({ a: 1, b: { c: 3 } });
    expect(log.writes.length).toEqual(1);
    expect(log.writes[0].path).toEqual(["b", "c"]);
  });

  it("should fail when setting a nested value on a frozen cell", () => {
    const testCell = cell({ a: 1, b: { c: 2 } });
    testCell.freeze();
    const log: ReactivityLog = { reads: [], writes: [] };
    const success = setNestedValue(testCell, [], { a: 1, b: { c: 3 } }, log);
    expect(success).toBe(false);
  });

  it("should correctly update with shorter arrays", () => {
    const testCell = cell({ a: [1, 2, 3] });
    const success = setNestedValue(testCell, ["a"], [1, 2]);
    expect(success).toBe(true);
    expect(testCell.get()).toEqual({ a: [1, 2] });
  });

  it("should correctly update with a longer arrays", () => {
    const testCell = cell({ a: [1, 2, 3] });
    const success = setNestedValue(testCell, ["a"], [1, 2, 3, 4]);
    expect(success).toBe(true);
    expect(testCell.get()).toEqual({ a: [1, 2, 3, 4] });
  });

  it("should overwrite an object with an array", () => {
    const testCell = cell({ a: { b: 1 } });
    const success = setNestedValue(testCell, ["a"], [1, 2, 3]);
    expect(success).toBe(true);
    expect(testCell.get()).toEqual({ a: [1, 2, 3] });
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

describe("followCellReferences", () => {
  it("should follow a simple cell reference", () => {
    const testCell = cell({ value: 42 });
    const reference: CellReference = { cell: testCell, path: ["value"] };
    const result = followCellReferences(reference);
    expect(result.cell.getAtPath(result.path)).toBe(42);
  });

  it("should follow nested cell references", () => {
    const innerCell = cell({ inner: 10 });
    const outerCell = cell({
      outer: { cell: innerCell, path: ["inner"] },
    });
    const reference: CellReference = { cell: outerCell, path: ["outer"] };
    const result = followCellReferences(reference);
    expect(result.cell.getAtPath(result.path)).toBe(10);
  });

  it("should throw an error on circular references", () => {
    const cellA = cell({});
    const cellB = cell({});
    cellA.send({ ref: { cell: cellB, path: ["ref"] } });
    cellB.send({ ref: { cell: cellA, path: ["ref"] } });
    const reference: CellReference = { cell: cellA, path: ["ref"] };
    expect(() => followCellReferences(reference)).toThrow(
      "Reference cycle detected"
    );
  });
});

describe("followAliases", () => {
  it("should follow a simple alias", () => {
    const testCell = cell({ value: 42 });
    const binding = { $alias: { path: ["value"] } };
    const result = followAliases(binding, testCell);
    expect(result.cell.getAtPath(result.path)).toBe(42);
  });

  it("should follow nested aliases", () => {
    const innerCell = cell({ inner: 10 });
    const outerCell = cell({
      outer: { $alias: { cell: innerCell, path: ["inner"] } },
    });
    const binding = { $alias: { path: ["outer"] } };
    const result = followAliases(binding, outerCell);
    expect(result.cell).toEqual(innerCell);
    expect(result.path).toEqual(["inner"]);
    expect(result.cell.getAtPath(result.path)).toBe(10);
  });

  it("should throw an error on circular aliases", () => {
    const cellA = cell({});
    const cellB = cell({});
    cellA.send({ alias: { $alias: { cell: cellB, path: ["alias"] } } });
    cellB.send({ alias: { $alias: { cell: cellA, path: ["alias"] } } });
    const binding = { $alias: { path: ["alias"] } };
    expect(() => followAliases(binding, cellA)).toThrow("Alias cycle detected");
  });
});

describe("compactifyPaths", () => {
  it("should compactify paths", () => {
    const testCell = cell({});
    const paths = [
      { cell: testCell, path: ["a", "b"] },
      { cell: testCell, path: ["a"] },
      { cell: testCell, path: ["c"] },
    ];
    const result = compactifyPaths(paths);
    expect(result).toEqual([
      { cell: testCell, path: ["a"] },
      { cell: testCell, path: ["c"] },
    ]);
  });

  it("should remove duplicate paths", () => {
    const testCell = cell({});
    const paths = [
      { cell: testCell, path: ["a", "b"] },
      { cell: testCell, path: ["a", "b"] },
    ];
    const result = compactifyPaths(paths);
    expect(result).toEqual([{ cell: testCell, path: ["a", "b"] }]);
  });

  it("should not compactify across cells", () => {
    const cellA = cell({});
    const cellB = cell({});
    const paths = [
      { cell: cellA, path: ["a", "b"] },
      { cell: cellB, path: ["a", "b"] },
    ];
    const result = compactifyPaths(paths);
    expect(result).toEqual(paths);
  });

  it("empty paths should trump all other ones", () => {
    const cellA = cell({});
    const paths = [
      { cell: cellA, path: ["a", "b"] },
      { cell: cellA, path: ["c"] },
      { cell: cellA, path: ["d"] },
      { cell: cellA, path: [] },
    ];
    const result = compactifyPaths(paths);
    expect(result).toEqual([{ cell: cellA, path: [] }]);
  });
});
