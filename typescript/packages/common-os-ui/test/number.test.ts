import { clamp } from "../src/shared/number.js";
import { describe, expect, it } from "vitest";

describe("clamp", () => {
  it("should clamp a number within the given range", () => {
    expect(clamp(5, 0, 10)).toEqual(5);
    expect(clamp(-5, 0, 10)).toEqual(0);
    expect(clamp(15, 0, 10)).toEqual(10);
  });

  it("should handle equal min and max values", () => {
    expect(clamp(5, 5, 5)).toEqual(5);
    expect(clamp(0, 5, 5)).toEqual(5);
    expect(clamp(10, 5, 5)).toEqual(5);
  });

  it("should handle floating-point numbers", () => {
    expect(clamp(3.14, 0, 5)).toEqual(3.14);
    expect(clamp(-1.5, -1, 1)).toEqual(-1);
    expect(clamp(2.7, 0.5, 2.5)).toEqual(2.5);
  });

  it("should handle negative ranges", () => {
    expect(clamp(0, -10, -5)).toEqual(-5);
    expect(clamp(-7, -10, -5)).toEqual(-7);
    expect(clamp(-12, -10, -5)).toEqual(-10);
  });

  it("should handle zero as a valid input and boundary", () => {
    expect(clamp(0, -5, 5)).toEqual(0);
    expect(clamp(-3, 0, 5)).toEqual(0);
    expect(clamp(3, -5, 0)).toEqual(0);
  });
});
