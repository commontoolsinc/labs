import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { resolveLinkScope } from "../src/scope.ts";

describe("scope helpers", () => {
  it("returns an explicit link scope unchanged", () => {
    expect(resolveLinkScope("session", "space")).toBe("session");
  });
});
