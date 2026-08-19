import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  defineAuthoredDebugAccessors,
  getAuthoredDebugSource,
  recordAuthoredDebugSource,
} from "../../src/harness/authored-debug-source.ts";
import { recordVerifiedProvenance } from "../../src/harness/verified-provenance.ts";
import { resolvePolicyFacingImplementationIdentity } from "../../src/cfc/implementation-identity.ts";
import type { Module } from "../../src/builder/types.ts";
import type { HarnessedFunction } from "../../src/harness/types.ts";

describe("authored-debug-source", () => {
  describe("recordAuthoredDebugSource()", () => {
    it("records the first debug entry without changing verified state", () => {
      const fn = () => {};
      recordAuthoredDebugSource(fn, {
        src: "cf:module/hash/main.tsx:2:4",
        bindingName: "first",
      });
      recordAuthoredDebugSource(fn, { bindingName: "second" });

      expect(getAuthoredDebugSource(fn)).toEqual({
        src: "cf:module/hash/main.tsx:2:4",
        bindingName: "first",
      });
    });

    it("cannot grant or change policy-facing implementation identity", () => {
      const verified = (() => {}) as unknown as HarnessedFunction;
      recordVerifiedProvenance(verified, {
        identity: "HASH",
        symbol: "__cfLift_1",
      });
      recordAuthoredDebugSource(verified, { src: "GARBLED" });

      const identity = resolvePolicyFacingImplementationIdentity(
        {} as Module,
        { implementation: verified },
      );
      expect(identity?.kind).toBe("verified");
      expect((identity as { moduleIdentity?: string }).moduleIdentity).toBe(
        "HASH",
      );

      const forged = (() => {}) as unknown as HarnessedFunction;
      recordAuthoredDebugSource(forged, {
        src: "cf:module/HASH/main.tsx:2:4",
      });
      expect(
        resolvePolicyFacingImplementationIdentity({} as Module, {
          implementation: forged,
        })?.kind,
      ).not.toBe("verified");
    });
  });

  describe("defineAuthoredDebugAccessors()", () => {
    it("serves metadata recorded after the function is frozen", () => {
      const fn = () => {};
      defineAuthoredDebugAccessors(fn);
      Object.freeze(fn);

      recordAuthoredDebugSource(fn, {
        src: "cf:module/hash/main.tsx:3:7",
        bindingName: "authored",
      });

      expect((fn as { src?: string }).src).toBe(
        "cf:module/hash/main.tsx:3:7",
      );
      expect(fn.name).toBe("authored");
    });

    it("leaves a non-configurable property untouched", () => {
      const fn = () => {};
      Object.defineProperty(fn, "src", {
        value: "fixed",
        configurable: false,
      });

      expect(() => defineAuthoredDebugAccessors(fn)).not.toThrow();
      recordAuthoredDebugSource(fn, {
        src: "cf:module/hash/main.tsx:4:1",
      });
      expect((fn as { src?: string }).src).toBe("fixed");
    });
  });
});
