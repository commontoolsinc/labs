import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { EMPTY_RECONSTRUCTION_CONTEXT } from "../empty-reconstruction-context.ts";

describe("EMPTY_RECONSTRUCTION_CONTEXT", () => {
  it("is a singleton (re-import yields the same instance)", async () => {
    const reimported = (await import("../empty-reconstruction-context.ts"))
      .EMPTY_RECONSTRUCTION_CONTEXT;
    expect(reimported).toBe(EMPTY_RECONSTRUCTION_CONTEXT);
  });

  it("throws on getCell()", () => {
    expect(() =>
      EMPTY_RECONSTRUCTION_CONTEXT.getCell({
        id: "of:bafyabc",
        path: [],
        space: "did:key:z1",
      })
    ).toThrow();
  });

  it("throw includes the requested ref id for debuggability", () => {
    expect(() =>
      EMPTY_RECONSTRUCTION_CONTEXT.getCell({
        id: "of:bafySPECIFIC",
        path: [],
        space: "did:key:z1",
      })
    ).toThrow(/of:bafySPECIFIC/);
  });

  it("is frozen (cannot have getCell replaced)", () => {
    expect(Object.isFrozen(EMPTY_RECONSTRUCTION_CONTEXT)).toBe(true);
  });

  it("shouldDeepFreeze is true (the safe default, mirrors cloneIfNecessary frozen)", () => {
    expect(EMPTY_RECONSTRUCTION_CONTEXT.shouldDeepFreeze).toBe(true);
  });
});
