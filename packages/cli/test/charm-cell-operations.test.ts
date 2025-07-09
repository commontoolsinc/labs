import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { parsePath } from "@commontools/charm/ops";

describe("parsePath", () => {
  it("should parse simple string paths", () => {
    expect(parsePath("name")).toEqual(["name"]);
    expect(parsePath("config")).toEqual(["config"]);
  });

  it("should parse nested paths", () => {
    expect(parsePath("config/settings/theme")).toEqual([
      "config",
      "settings",
      "theme",
    ]);
  });

  it("should convert numeric segments to numbers", () => {
    expect(parsePath("users/0/name")).toEqual(["users", 0, "name"]);
    expect(parsePath("items/10/value")).toEqual(["items", 10, "value"]);
  });

  it("should handle mixed string and number paths", () => {
    expect(parsePath("data/items/1/tags/2")).toEqual([
      "data",
      "items",
      1,
      "tags",
      2,
    ]);
  });

  it("should return empty array for empty string", () => {
    expect(parsePath("")).toEqual([]);
  });

  it("should handle paths with only numbers", () => {
    expect(parsePath("0/1/2")).toEqual([0, 1, 2]);
  });

  it("should not convert non-integer numbers", () => {
    expect(parsePath("value/3.14/pi")).toEqual(["value", "3.14", "pi"]);
    // Note: 1e5 is considered an integer (100000) by JavaScript
    expect(parsePath("data/1e5/scientific")).toEqual([
      "data",
      100000,
      "scientific",
    ]);
  });

  it("should reject negative numbers and keep them as strings", () => {
    // Negative integers are NOT converted to numbers (remain as strings)
    expect(parsePath("values/-1/negative")).toEqual([
      "values",
      "-1",
      "negative",
    ]);
    // Non-integer negative numbers remain as strings
    expect(parsePath("values/-3.14/float")).toEqual([
      "values",
      "-3.14",
      "float",
    ]);
  });

  it("should handle paths with special characters", () => {
    expect(parsePath("user@email/domain")).toEqual([
      "user@email",
      "domain",
    ]);
    expect(parsePath("key-with-dash/value")).toEqual([
      "key-with-dash",
      "value",
    ]);
  });

  it("should handle single-segment paths", () => {
    expect(parsePath("singleKey")).toEqual(["singleKey"]);
    expect(parsePath("0")).toEqual([0]);
  });
});
