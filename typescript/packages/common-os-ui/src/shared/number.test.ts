import { clamp } from "./number.js";
import * as assert from "node:assert/strict";

describe("clamp", () => {
  it("should clamp a number within the given range", () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-5, 0, 10), 0);
    assert.equal(clamp(15, 0, 10), 10);
  });

  it("should handle equal min and max values", () => {
    assert.equal(clamp(5, 5, 5), 5);
    assert.equal(clamp(0, 5, 5), 5);
    assert.equal(clamp(10, 5, 5), 5);
  });

  it("should handle floating-point numbers", () => {
    assert.equal(clamp(3.14, 0, 5), 3.14);
    assert.equal(clamp(-1.5, -1, 1), -1);
    assert.equal(clamp(2.7, 0.5, 2.5), 2.5);
  });

  it("should handle negative ranges", () => {
    assert.equal(clamp(0, -10, -5), -5);
    assert.equal(clamp(-7, -10, -5), -7);
    assert.equal(clamp(-12, -10, -5), -10);
  });

  it("should handle zero as a valid input and boundary", () => {
    assert.equal(clamp(0, -5, 5), 0);
    assert.equal(clamp(-3, 0, 5), 0);
    assert.equal(clamp(3, -5, 0), 0);
  });
});
