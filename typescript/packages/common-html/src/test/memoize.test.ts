import { equal as assertEqual } from "node:assert/strict";
import memoize from "../memoize.js";

describe("memoize", () => {
  it("caches the values", () => {
    const split = (x: string) => Object.freeze(x.split(""));
    const msplit = memoize(split);

    const a = msplit("abc");
    const b = msplit("abc");
    assertEqual(a, b);
  });
});
