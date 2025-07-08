import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { parseCellPath } from "../commands/charm.ts";

describe("parseCellPath", () => {
  it("should parse simple string paths", () => {
    expect(parseCellPath("name")).toEqual(["name"]);
    expect(parseCellPath("config")).toEqual(["config"]);
  });

  it("should parse nested paths", () => {
    expect(parseCellPath("config/settings/theme")).toEqual([
      "config",
      "settings",
      "theme",
    ]);
  });

  it("should convert numeric segments to numbers", () => {
    expect(parseCellPath("users/0/name")).toEqual(["users", 0, "name"]);
    expect(parseCellPath("items/10/value")).toEqual(["items", 10, "value"]);
  });

  it("should handle mixed string and number paths", () => {
    expect(parseCellPath("data/items/1/tags/2")).toEqual([
      "data",
      "items",
      1,
      "tags",
      2,
    ]);
  });

  it("should return empty array for empty string", () => {
    expect(parseCellPath("")).toEqual([]);
  });

  it("should handle paths with only numbers", () => {
    expect(parseCellPath("0/1/2")).toEqual([0, 1, 2]);
  });

  it("should not convert non-integer numbers", () => {
    expect(parseCellPath("value/3.14/pi")).toEqual(["value", "3.14", "pi"]);
    // Note: 1e5 is considered an integer (100000) by JavaScript
    expect(parseCellPath("data/1e5/scientific")).toEqual([
      "data",
      100000,
      "scientific",
    ]);
  });

  it("should handle negative numbers", () => {
    // Negative integers are converted to numbers
    expect(parseCellPath("values/-1/negative")).toEqual([
      "values",
      -1,
      "negative",
    ]);
    // Non-integer negative numbers remain as strings
    expect(parseCellPath("values/-3.14/float")).toEqual([
      "values",
      "-3.14",
      "float",
    ]);
  });

  it("should handle paths with special characters", () => {
    expect(parseCellPath("user@email/domain")).toEqual([
      "user@email",
      "domain",
    ]);
    expect(parseCellPath("key-with-dash/value")).toEqual([
      "key-with-dash",
      "value",
    ]);
  });

  it("should handle single-segment paths", () => {
    expect(parseCellPath("singleKey")).toEqual(["singleKey"]);
    expect(parseCellPath("0")).toEqual([0]);
  });
});