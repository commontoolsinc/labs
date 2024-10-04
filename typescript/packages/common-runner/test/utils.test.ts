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
  normalizeToCells,
} from "../src/utils.js";
import {
  cell,
  CellReference,
  ReactivityLog,
  isCellReference,
} from "../src/cell.js";

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
    expect(testCell.getAsProxy()).toEqual({ arr: [1, 0, 3] });
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
    expect(testCell.getAsProxy()).toEqual({ a: [1, 2] });
  });

  it("should correctly update with a longer arrays", () => {
    const testCell = cell({ a: [1, 2, 3] });
    const success = setNestedValue(testCell, ["a"], [1, 2, 3, 4]);
    expect(success).toBe(true);
    expect(testCell.getAsProxy()).toEqual({ a: [1, 2, 3, 4] });
  });

  it("should overwrite an object with an array", () => {
    const testCell = cell({ a: { b: 1 } });
    const success = setNestedValue(testCell, ["a"], [1, 2, 3]);
    expect(success).toBeTruthy();
    expect(testCell.get()).toHaveProperty("a");
    expect(testCell.get().a).toHaveLength(3);
    expect(testCell.getAsProxy().a).toEqual([1, 2, 3]);
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

describe("makeArrayElementsAllCells", () => {
  it("should convert non-cell array elements to cell references", () => {
    const input = [1, 2, 3];
    normalizeToCells(input);

    expect(input.length).toBe(3);
    input.forEach((item) => {
      expect(isCellReference(item)).toBe(true);
    });
  });

  it("should not modify existing cell references, cells, or aliases", () => {
    const cellRef = { cell: cell(42), path: [] };
    const cellInstance = cell(43);
    const alias = { $alias: { path: ["some", "path"] } };
    const input = [cellRef, cellInstance, alias];

    normalizeToCells(input);

    expect(input[0]).toBe(cellRef);
    expect(input[1]).toBe(cellInstance);
    expect(input[2]).toBe(alias);
  });

  it("should handle nested arrays", () => {
    const input = [1, [2, 3], 4];
    normalizeToCells(input);

    expect(isCellReference(input[0])).toBe(true);
    expect(isCellReference(input[1])).toBe(true);
    const { cell, path } = input[1] as unknown as CellReference;
    expect(cell).toBeDefined();
    expect(path).toEqual([]);
    expect(Array.isArray(cell.get())).toBe(true);
    (cell.get() as any[]).forEach((item) => {
      expect(isCellReference(item)).toBe(true);
    });
    expect(isCellReference(input[2])).toBe(true);
  });

  it("should handle objects with array properties", () => {
    const input = { arr: [1, 2, 3], nested: { arr: [4, 5] } };
    const changed = normalizeToCells(input);

    expect(changed).toBe(true);
    input.arr.forEach((item) => {
      expect(isCellReference(item)).toBe(true);
    });
    input.nested.arr.forEach((item) => {
      expect(isCellReference(item)).toBe(true);
    });
  });

  it("should not modify non-array, non-object values", () => {
    const input = 42;
    normalizeToCells(input);
    expect(input).toBe(42);
  });

  it("should reuse cell references if value hasn't changed", () => {
    const previousCell = cell(42);
    const previousInput = [{ cell: previousCell, path: [] }];
    const newInput = [42];

    const changed = normalizeToCells(newInput, previousInput);

    expect(changed).toBe(false);
    expect(newInput[0]).toBe(previousInput[0]);
    expect(isCellReference(newInput[0])).toBe(true);
    expect((newInput[0] as unknown as CellReference).cell).toBe(previousCell);
  });

  it("should create new cell reference if value has changed", () => {
    const previousCell = cell(42);
    const previousInput = [{ cell: previousCell, path: [] }];
    const newInput = [43];

    const changed = normalizeToCells(newInput, previousInput);

    expect(changed).toBe(true);
    expect(newInput[0]).not.toBe(previousInput[0]);
    expect(isCellReference(newInput[0])).toBe(true);
    expect((newInput[0] as unknown as CellReference).cell.get()).toBe(43);
  });

  it("should handle nested objects and arrays", () => {
    const previousInput = {
      arr: [
        { cell: cell(1), path: [] } satisfies CellReference,
        { cell: cell(2), path: [] } satisfies CellReference,
      ],
      nested: { value: { cell: cell(3), path: [] } satisfies CellReference },
    };
    const newInput = {
      arr: [1, 3],
      nested: { value: 3 },
    };

    const changed = normalizeToCells(newInput, previousInput);

    expect(changed).toBe(true);
    expect(isCellReference(newInput.arr[0])).toBe(true);
    expect((newInput.arr[0] as unknown as CellReference).cell).toBe(
      previousInput.arr[0].cell
    );
    expect(isCellReference(newInput.arr[1])).toBe(true);
    expect((newInput.arr[1] as unknown as CellReference).cell.get()).toBe(3);
    expect(isCellReference(newInput.nested.value)).toBe(false);
    expect(newInput.nested.value).toBe(3); // Cell is overwritten
  });

  it("should detect changes in cell references", () => {
    const cell1 = cell(1);
    const cell2 = cell(2);
    const previousInput = { cell: cell1, path: ["a"] };
    const newInput = { cell: cell2, path: ["b"] };

    const changed = normalizeToCells(newInput, previousInput);

    expect(changed).toBe(true);
  });

  it("should detect changes in aliases", () => {
    const cell1 = cell(1);
    const cell2 = cell(2);
    const previousInput = { $alias: { cell: cell1, path: ["a"] } };
    const newInput = { $alias: { cell: cell2, path: ["b"] } };

    const changed = normalizeToCells(newInput, previousInput);

    expect(changed).toBe(true);
  });

  it("should handle null and undefined values", () => {
    const previousInput = { foo: null };
    const newInput = { foo: null };

    const changed = normalizeToCells(newInput, previousInput);

    expect(changed).toBe(false);
  });

  it("should detect non-array changes: property changes", () => {
    const previousInput = { foo: "bar" };
    const newInput = { foo: "baz" };

    const changed = normalizeToCells(newInput, previousInput);

    expect(changed).toBe(true);
  });

  it("should detect non-array changes: new props", () => {
    const previousInput = { foo: "bar" };
    const newInput = { foo: "bar", baz: "qux" };

    const changed = normalizeToCells(newInput, previousInput);

    expect(changed).toBe(true);
  });

  it("should detect non-array changes: missing props", () => {
    const previousInput = { foo: "bar", baz: "qux" };
    const newInput = { foo: "bar" };

    const changed = normalizeToCells(newInput, previousInput);

    expect(changed).toBe(true);
  });
});
