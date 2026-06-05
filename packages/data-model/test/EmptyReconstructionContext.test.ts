import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  EMPTY_RECONSTRUCTION_CONTEXT,
  EmptyReconstructionContext,
} from "../src/wire-common/EmptyReconstructionContext.ts";

describe("EmptyReconstructionContext", () => {
  describe("EMPTY_RECONSTRUCTION_CONTEXT", () => {
    it("is a singleton (re-import yields the same instance)", async () => {
      const reimported =
        (await import("../src/wire-common/EmptyReconstructionContext.ts"))
          .EMPTY_RECONSTRUCTION_CONTEXT;
      expect(reimported).toBe(EMPTY_RECONSTRUCTION_CONTEXT);
    });

    it("throws on `getCell()`", () => {
      expect(() =>
        EMPTY_RECONSTRUCTION_CONTEXT.getCell({
          id: "of:bafyabc",
          path: [],
          space: "did:key:z1",
        })
      ).toThrow();
    });

    it("includes the requested ref id in the throw for debuggability", () => {
      expect(() =>
        EMPTY_RECONSTRUCTION_CONTEXT.getCell({
          id: "of:bafySPECIFIC",
          path: [],
          space: "did:key:z1",
        })
      ).toThrow(/of:bafySPECIFIC/);
    });

    it("is frozen (cannot have `getCell()` replaced)", () => {
      expect(Object.isFrozen(EMPTY_RECONSTRUCTION_CONTEXT)).toBe(true);
    });

    it("reports `shouldDeepFreeze` as `true` (the safe default, mirrors `cloneIfNecessary()` frozen)", () => {
      expect(EMPTY_RECONSTRUCTION_CONTEXT.shouldDeepFreeze).toBe(true);
    });
  });

  describe("`EmptyReconstructionContext` (exported class)", () => {
    it("throws the expected default message (default ctor)", () => {
      const ctx = new EmptyReconstructionContext(true);
      expect(() =>
        ctx.getCell({ id: "of:bafyDEFAULT", path: [], space: "did:key:z1" })
      ).toThrow(
        "Cannot reconstruct cell reference `of:bafyDEFAULT`: no runtime context provided.",
      );
    });

    it("correctly passes `shouldDeepFreeze` to the superclass", () => {
      expect(new EmptyReconstructionContext(false).shouldDeepFreeze).toBe(
        false,
      );
      expect(new EmptyReconstructionContext(true).shouldDeepFreeze).toBe(true);
    });

    it("parameterizes only the after-colon clause via the `getCellMessage` arg", () => {
      const ctx = new EmptyReconstructionContext(true, "custom");
      expect(() =>
        ctx.getCell({ id: "of:bafyCUSTOM", path: [], space: "did:key:z1" })
      ).toThrow("Cannot reconstruct cell reference `of:bafyCUSTOM`: custom");
    });

    it("correctly accepts the two-argument form", () => {
      const ctx = new EmptyReconstructionContext(false, "deep-clone path.");
      expect(ctx.shouldDeepFreeze).toBe(false);
      expect(() =>
        ctx.getCell({ id: "of:bafyX", path: [], space: "did:key:z1" })
      )
        .toThrow(
          "Cannot reconstruct cell reference `of:bafyX`: deep-clone path.",
        );
    });
  });
});
