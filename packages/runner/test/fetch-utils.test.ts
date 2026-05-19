import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  resetDataModelConfig,
  setDataModelConfig,
} from "@commonfabric/data-model/fabric-value";
import { computeInputHashFromValue } from "../src/builtins/fetch-utils.ts";

// ============================================================================
// Tests
// ============================================================================
//
// `computeInputHashFromValue()` must produce a stable hash across legacy and
// modern fabric-value-layer states. In particular, callers commonly build
// snapshots via unconditional object construction, so omitted-key versus
// present-but-`undefined` must hash identically -- a property the legacy
// layer used to provide implicitly, and which the function now normalizes
// directly.

describe("computeInputHashFromValue", () => {
  afterEach(() => {
    resetDataModelConfig();
  });

  for (const modernMode of [false, true]) {
    const label = modernMode ? "modern" : "legacy";

    describe(`(${label} path)`, () => {
      beforeEach(() => setDataModelConfig(modernMode));

      it("drops the top-level `result` type-hint field", () => {
        const a = computeInputHashFromValue({ url: "x", mode: "json" });
        const b = computeInputHashFromValue({
          url: "x",
          mode: "json",
          result: "ignored type hint",
        });
        expect(a).toBe(b);
      });

      it("treats omitted vs `undefined` top-level properties identically", () => {
        const a = computeInputHashFromValue({ url: "x", mode: "json" });
        const b = computeInputHashFromValue({
          url: "x",
          mode: "json",
          options: undefined,
        });
        expect(a).toBe(b);
      });

      it("treats omitted vs `undefined` nested properties identically", () => {
        const a = computeInputHashFromValue({
          url: "x",
          options: { method: "GET" },
        });
        const b = computeInputHashFromValue({
          url: "x",
          options: { method: "GET", body: undefined },
        });
        expect(a).toBe(b);
      });

      it("distinguishes inputs that differ in non-`undefined` content", () => {
        const a = computeInputHashFromValue({ url: "x", mode: "json" });
        const b = computeInputHashFromValue({ url: "y", mode: "json" });
        expect(a).not.toBe(b);
      });

      it("treats `undefined` inputs as the empty object", () => {
        const a = computeInputHashFromValue(undefined);
        const b = computeInputHashFromValue({});
        expect(a).toBe(b);
      });
    });
  }

  describe("(flag-independent output)", () => {
    afterEach(() => {
      resetDataModelConfig();
    });

    it("produces the same hash under legacy and modern for the same inputs", () => {
      const inputs = {
        url: "http://example/api",
        mode: "json" as const,
        options: { method: "GET", body: undefined },
      };
      setDataModelConfig(false);
      const legacyHash = computeInputHashFromValue(inputs);
      setDataModelConfig(true);
      const modernHash = computeInputHashFromValue(inputs);
      expect(modernHash).toBe(legacyHash);
    });
  });
});
