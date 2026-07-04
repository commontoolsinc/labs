import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { nonPrivateRandom, safeDateNow } from "../src/builder/safe-builtins.ts";

describe("safe builtins", () => {
  it("returns ambient random and time values", () => {
    const random = nonPrivateRandom();
    expect(random).toBeGreaterThanOrEqual(0);
    expect(random).toBeLessThan(1);

    const before = Date.now();
    const now = safeDateNow();
    const after = Date.now();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});
