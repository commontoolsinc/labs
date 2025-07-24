import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { expectWithSymbolMatchers, stripSymbols } from "./matchers.ts";
import "./matchers.ts"; // Import to register the custom matcher

const testSymbol1 = Symbol("test1");
const testSymbol2 = Symbol("test2");

describe("stripSymbols", () => {
  it("should strip symbols from objects", () => {
    const obj = {
      name: "test",
      [testSymbol1]: "should be removed",
      value: 42,
    };

    expect(stripSymbols(obj)).toEqual({
      name: "test",
      value: 42,
    });
  });

  it("should strip symbols from nested objects", () => {
    const obj = {
      user: {
        name: "John",
        [testSymbol1]: "removed",
        settings: {
          theme: "dark",
          [testSymbol2]: "also removed",
        },
      },
    };

    expect(stripSymbols(obj)).toEqual({
      user: {
        name: "John",
        settings: {
          theme: "dark",
        },
      },
    });
  });

  it("should handle arrays", () => {
    const arr = [
      { name: "a", [testSymbol1]: "removed" },
      { name: "b", [testSymbol2]: "removed" },
    ];

    expect(stripSymbols(arr)).toEqual([
      { name: "a" },
      { name: "b" },
    ]);
  });

  it("should handle primitives", () => {
    expect(stripSymbols(42)).toBe(42);
    expect(stripSymbols("string")).toBe("string");
    expect(stripSymbols(true)).toBe(true);
    expect(stripSymbols(null)).toBe(null);
    expect(stripSymbols(undefined)).toBe(undefined);
  });
});

describe("toEqualIgnoringSymbols matcher", () => {
  it("should match objects ignoring symbols", () => {
    const obj1 = {
      name: "test",
      [testSymbol1]: "ignored",
      value: 42,
    };

    const obj2 = {
      name: "test",
      value: 42,
    };

    expect(obj1).toEqualIgnoringSymbols(obj2);
  });

  it("should match nested objects ignoring symbols", () => {
    const obj1 = {
      user: {
        name: "John",
        [testSymbol1]: "ignored",
        settings: {
          theme: "dark",
          [testSymbol2]: "also ignored",
        },
      },
    };

    const obj2 = {
      user: {
        name: "John",
        settings: {
          theme: "dark",
        },
      },
    };

    expect(obj1).toEqualIgnoringSymbols(obj2);
  });

  it("should fail when objects differ in non-symbol properties", () => {
    const obj1 = {
      name: "test1",
      [testSymbol1]: "ignored",
    };

    const obj2 = {
      name: "test2",
    };

    expect(() => {
      expect(obj1).toEqualIgnoringSymbols(obj2);
    }).toThrow();
  });

  it("should handle arrays with symbols", () => {
    const arr1 = [
      { name: "a", [testSymbol1]: "ignored" },
      { name: "b", [testSymbol2]: "ignored" },
    ];

    const arr2 = [
      { name: "a" },
      { name: "b" },
    ];

    expect(arr1).toEqualIgnoringSymbols(arr2);
  });
});

describe("toMatchObjectIgnoringSymbols matcher", () => {
  it("should match objects partially ignoring symbols", () => {
    const obj1 = {
      name: "test",
      [testSymbol1]: "ignored",
      value: 42,
      extra: "field",
    };

    const obj2 = {
      name: "test",
      value: 42,
    };

    expect(obj1).toMatchObjectIgnoringSymbols(obj2);
  });

  it("should match nested objects partially ignoring symbols", () => {
    const obj1 = {
      user: {
        name: "John",
        [testSymbol1]: "ignored",
        age: 30,
        settings: {
          theme: "dark",
          [testSymbol2]: "also ignored",
          fontSize: 14,
        },
      },
      extraField: true,
    };

    const obj2 = {
      user: {
        name: "John",
        settings: {
          theme: "dark",
        },
      },
    };

    expect(obj1).toMatchObjectIgnoringSymbols(obj2);
  });

  it("should fail when required properties are missing", () => {
    const obj1 = {
      name: "test",
      [testSymbol1]: "ignored",
    };

    const obj2 = {
      name: "test",
      value: 42, // This property is missing in obj1
    };

    expect(() => {
      expect(obj1).toMatchObjectIgnoringSymbols(obj2);
    }).toThrow();
  });
});
