/**
 * The stand-in used when a decode has no runtime behind it: a shared singleton
 * that refuses every cell resolution, and the class it is an instance of.
 *
 * Refusing is the entire behavior, so what is left to get right is that it
 * refuses informatively and cannot be talked out of it -- the failure names
 * the ref it was asked for, and the singleton is frozen so `getCell()` cannot
 * be swapped. The class is exported so a caller can frame that failure for its
 * own situation, and only the clause after the colon is the caller's to
 * supply.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  EMPTY_DECODE_CONTEXT,
  EmptyDecodeContext,
} from "@/codec-interface/EmptyDecodeContext.ts";

describe("EmptyDecodeContext", () => {
  describe("EMPTY_DECODE_CONTEXT", () => {
    it("is a singleton (re-import yields the same instance)", async () => {
      const reimported =
        (await import("@/codec-interface/EmptyDecodeContext.ts"))
          .EMPTY_DECODE_CONTEXT;
      expect(reimported).toBe(EMPTY_DECODE_CONTEXT);
    });

    it("throws on `getCell()`", () => {
      expect(() =>
        EMPTY_DECODE_CONTEXT.getCell({
          id: "of:bafyabc",
          path: [],
          space: "did:key:z1",
        })
      ).toThrow();
    });

    it("includes the requested ref id in the throw for debuggability", () => {
      expect(() =>
        EMPTY_DECODE_CONTEXT.getCell({
          id: "of:bafySPECIFIC",
          path: [],
          space: "did:key:z1",
        })
      ).toThrow(/of:bafySPECIFIC/);
    });

    it("is frozen (cannot have `getCell()` replaced)", () => {
      expect(Object.isFrozen(EMPTY_DECODE_CONTEXT)).toBe(true);
    });

    it("reports `shouldDeepFreeze` as `true` (the safe default, mirrors `cloneIfNecessary()` frozen)", () => {
      expect(EMPTY_DECODE_CONTEXT.shouldDeepFreeze).toBe(true);
    });
  });

  describe("`EmptyDecodeContext` (exported class)", () => {
    it("throws the expected default message (default ctor)", () => {
      const ctx = new EmptyDecodeContext(true);
      expect(() =>
        ctx.getCell({ id: "of:bafyDEFAULT", path: [], space: "did:key:z1" })
      ).toThrow(
        "Cannot reconstruct cell reference `of:bafyDEFAULT`: no runtime context provided.",
      );
    });

    it("correctly passes `shouldDeepFreeze` to the superclass", () => {
      expect(new EmptyDecodeContext(false).shouldDeepFreeze).toBe(
        false,
      );
      expect(new EmptyDecodeContext(true).shouldDeepFreeze).toBe(true);
    });

    it("parameterizes only the after-colon clause via the `getCellMessage` arg", () => {
      const ctx = new EmptyDecodeContext(true, "custom");
      expect(() =>
        ctx.getCell({ id: "of:bafyCUSTOM", path: [], space: "did:key:z1" })
      ).toThrow("Cannot reconstruct cell reference `of:bafyCUSTOM`: custom");
    });

    it("correctly accepts the two-argument form", () => {
      const ctx = new EmptyDecodeContext(false, "deep-clone path.");
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
