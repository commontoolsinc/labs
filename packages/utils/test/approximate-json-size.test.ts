/**
 * `approximateJsonSize()` stands in for the length of a value's JSON text
 * without producing it. The cases pin the two things a reader of the figure
 * relies on: that it tracks the JSON length where JSON would write the same
 * thing, and that the walk visits a tree of any depth and no byte buffer.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { approximateJsonSize } from "@commonfabric/utils/approximate-json-size";

describe("approximateJsonSize()", () => {
  it("returns the JSON length of a value holding strings, keywords and containers", () => {
    const value = {
      name: "donut",
      glazed: true,
      filling: null,
      toppings: ["sprinkles", "sugar"],
      nested: { empty: {}, none: [] },
    };
    expect(approximateJsonSize(value).bytes).toBe(
      JSON.stringify(value).length,
    );
  });

  it("counts a number as eight, whatever it would write as", () => {
    expect(approximateJsonSize(1).bytes).toBe(8);
    expect(approximateJsonSize(123456789.25).bytes).toBe(8);
  });

  it("counts a string by its length in code units", () => {
    expect(approximateJsonSize("héllo").bytes).toBe("héllo".length + 2);
  });

  it("counts one node per container and per leaf", () => {
    expect(approximateJsonSize({ a: [1, 2], b: "x" }).nodes).toBe(5);
  });

  it("counts a byte buffer by its byte length without walking it", () => {
    expect(approximateJsonSize(new Uint8Array(10))).toEqual({
      bytes: 10,
      nodes: 1,
    });
    expect(approximateJsonSize(new ArrayBuffer(7))).toEqual({
      bytes: 7,
      nodes: 1,
    });
  });

  it("walks a class instance through its own enumerable properties alone", () => {
    class Glaze {
      flavor = "maple";
      get thickness(): number {
        return 2;
      }
    }
    expect(approximateJsonSize(new Glaze()).bytes).toBe(
      JSON.stringify({ flavor: "maple" }).length,
    );
  });

  it("walks a value deeper than a recursive walk could", () => {
    let value: unknown[] = [];
    for (let depth = 0; depth < 100_000; depth++) value = [value];
    expect(approximateJsonSize(value).nodes).toBe(100_001);
  });
});
