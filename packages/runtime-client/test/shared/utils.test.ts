import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { describeFailure } from "@/shared/utils.ts";

describe("describeFailure", () => {
  it("returns an `Error`'s message", () => {
    expect(describeFailure(new Error("boom"))).toBe("boom");
  });

  it("returns the text of a value thrown that is not an `Error`", () => {
    expect(describeFailure("plain")).toBe("plain");
    expect(describeFailure(42)).toBe("42");
    expect(describeFailure(undefined)).toBe("undefined");
  });

  it("returns `/undescribable` for a value that refuses coercion", () => {
    // `String()` reaches for `toString` and `valueOf`; an object made with
    // `Object.create(null)` has neither to find.
    expect(describeFailure(Object.create(null))).toBe("/undescribable");
  });

  it("returns `/undescribable` when reading the message throws", () => {
    const hostile = new Error("unreachable");
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("no message for you");
      },
    });
    expect(describeFailure(hostile)).toBe("/undescribable");
  });
});
