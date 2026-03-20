import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { unwrapReturnedCells } from "../lib/piece.ts";

describe("unwrapReturnedCells", () => {
  it("dereferences linked cell values until plain data", () => {
    const innerCell = { get: () => 10 };
    const outerCell = { get: () => innerCell };

    const result = unwrapReturnedCells(outerCell, isMockCell);

    expect(result).toBe(10);
  });

  it("leaves plain values unchanged", () => {
    expect(unwrapReturnedCells("hello", isMockCell)).toBe("hello");
    expect(unwrapReturnedCells({ value: 10 }, isMockCell)).toEqual({
      value: 10,
    });
  });

  it("throws on cyclic cell references", () => {
    const firstCell: { get(): unknown } = {
      get: () => secondCell,
    };
    const secondCell: { get(): unknown } = {
      get: () => firstCell,
    };

    expect(() => unwrapReturnedCells(firstCell, isMockCell)).toThrow(
      /cyclic cell reference/i,
    );
  });
});

function isMockCell(value: unknown): value is { get(): unknown } {
  return typeof value === "object" &&
    value !== null &&
    "get" in value &&
    typeof value.get === "function";
}
