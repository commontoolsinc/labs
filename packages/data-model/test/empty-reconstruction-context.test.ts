import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  EMPTY_RECONSTRUCTION_CONTEXT,
  EmptyReconstructionContext,
} from "../empty-reconstruction-context.ts";

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

describe("EmptyReconstructionContext (exported class)", () => {
  it("default ctor: shouldDeepFreeze true + the historical verbatim throw message", () => {
    const ctx = new EmptyReconstructionContext();
    expect(ctx.shouldDeepFreeze).toBe(true);
    expect(() =>
      ctx.getCell({ id: "of:bafyDEFAULT", path: [], space: "did:key:z1" })
    ).toThrow(
      "Cannot reconstruct cell reference `of:bafyDEFAULT`: no runtime context provided.",
    );
  });

  it("shouldDeepFreeze arg is forwarded (false stays false)", () => {
    expect(new EmptyReconstructionContext(false).shouldDeepFreeze).toBe(false);
    expect(new EmptyReconstructionContext(true).shouldDeepFreeze).toBe(true);
  });

  it("getCellMessage arg parameterizes only the after-colon clause", () => {
    const ctx = new EmptyReconstructionContext(true, "custom");
    expect(() =>
      ctx.getCell({ id: "of:bafyCUSTOM", path: [], space: "did:key:z1" })
    ).toThrow("Cannot reconstruct cell reference `of:bafyCUSTOM`: custom");
  });

  it("the two args are independent (frozen-intent context with a situation message)", () => {
    const ctx = new EmptyReconstructionContext(false, "deep-clone path.");
    expect(ctx.shouldDeepFreeze).toBe(false);
    expect(() => ctx.getCell({ id: "of:bafyX", path: [], space: "did:key:z1" }))
      .toThrow(
        "Cannot reconstruct cell reference `of:bafyX`: deep-clone path.",
      );
  });
});
