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

  it("counts a number as eight and a bigint as twenty, whatever they would write as", () => {
    expect(approximateJsonSize(1).bytes).toBe(8);
    expect(approximateJsonSize(123456789.25).bytes).toBe(8);
    expect(approximateJsonSize(7n).bytes).toBe(20);
  });

  it("counts `false` as five and `true` as four", () => {
    expect(approximateJsonSize([true, false]).bytes).toBe(
      JSON.stringify([true, false]).length,
    );
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
      complete: true,
    });
    expect(approximateJsonSize(new ArrayBuffer(7))).toEqual({
      bytes: 7,
      nodes: 1,
      complete: true,
    });
  });

  it("counts a sparse array's holes as JSON writes them, queuing none of them", () => {
    const sparse = new Array(100_000);
    sparse[99_999] = "end";

    expect(approximateJsonSize(sparse)).toEqual({
      bytes: JSON.stringify(sparse).length,
      nodes: 100_001,
      complete: true,
    });
  });

  it("takes an instance's size from the caller's hook when it gives one", () => {
    class Payload {
      #bytes = new Uint8Array(32);
      get length(): number {
        return this.#bytes.length;
      }
    }
    const instanceSize = (instance: object) =>
      instance instanceof Payload ? instance.length : undefined;

    expect(approximateJsonSize({ p: new Payload() }, { instanceSize }).bytes)
      .toBe(2 + "p".length + 3 + 32);
    expect(approximateJsonSize({ p: new Payload() }).bytes)
      .toBe(JSON.stringify({ p: {} }).length);
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

  it("stops at the node limit and reports the walk incomplete", () => {
    const wide = { a: Array.from({ length: 1_000 }, () => "x"), b: { c: 1 } };

    const partial = approximateJsonSize(wide, { nodeLimit: 100 });
    const whole = approximateJsonSize(wide);

    expect(partial.complete).toBe(false);
    expect(partial.nodes).toBe(100);
    expect(partial.bytes).toBeLessThan(whole.bytes);
    expect(whole.complete).toBe(true);
    expect(approximateJsonSize(wide, { nodeLimit: whole.nodes })).toEqual(
      whole,
    );
  });

  it("walks a value deeper than a recursive walk could", () => {
    let value: unknown[] = [];
    for (let depth = 0; depth < 100_000; depth++) value = [value];
    expect(approximateJsonSize(value).nodes).toBe(100_001);
  });
});
