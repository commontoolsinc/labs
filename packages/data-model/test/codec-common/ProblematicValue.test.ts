/**
 * What a decode produces when it recognized the tag but could not make sense
 * of the state: the tag, the state as it arrived, and the error explaining the
 * refusal.
 *
 * Keeping all three is what lets a bad encoding survive a round trip without
 * being either lost or believed. Encoding one writes back the bare state, the
 * tag it carries being per-instance and travelling separately, so a value that
 * could not be understood is re-emitted as what it was rather than as what
 * this runtime would have written in its place.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
} from "@/codec-common/BaseFabricInstance.ts";
import { CODEC } from "@/codec-interface/interface.ts";
import { ProblematicValue } from "@/codec-common/ProblematicValue.ts";
import { ExplicitTagValue } from "@/codec-common/ExplicitTagValue.ts";
import { deepFreeze, isDeepFrozenFabricValue } from "@/deep-freeze.ts";
import { subFreeze, subIsDeepFrozen } from "../fabric-instances/fixtures.ts";

describe("ProblematicValue", () => {
  // Subclass-checking-superclass identity: lives directly under the class
  // describe (the rule's cross-cutting carve-out).
  it("is an instance of `ExplicitTagValue`", () => {
    const ps = new ProblematicValue("Test@1", "state", "oops");
    expect(ps instanceof ExplicitTagValue).toBe(true);
  });

  describe("constructor()", () => {
    it("preserves `wireTypeTag`, `state`, and `error`", () => {
      const ps = new ProblematicValue("BadType@1", { x: 1 }, "boom");
      expect(ps.wireTypeTag).toBe("BadType@1");
      expect(ps.state).toEqual({ x: 1 });
      expect(ps.error).toBe("boom");
    });

    it("keeps a `FabricValue` state by identity", () => {
      const state = { x: 1, nested: [2, 3] };

      expect(new ProblematicValue("T@1", state, "boom").state).toBe(state);
    });

    it("renders a non-`FabricValue` state as a debug string", () => {
      const ps = new ProblematicValue("T@1", new Uint8Array([1, 2]), "boom");

      expect(typeof ps.state).toBe("string");
      // A description of the value, not a conversion of it: nothing here
      // should read as though the wire carried a `FabricBytes`.
      expect(ps.state).toMatch(/Uint8Array/);
    });

    it("survives a state that cannot be frozen", () => {
      // The reason coercion belongs in the constructor rather than at each
      // call site: `Object.freeze()` throws on a typed array with elements,
      // and this class deep-freezes its state. Reporting a failure must not
      // itself fail.
      const ps = new ProblematicValue("T@1", new Uint8Array([1, 2, 3]), "b");

      expect(() => deepFreeze(ps)).not.toThrow();
    });

    it("survives a state whose own membership check throws", () => {
      // Prophylaxis rather than a proxy guard: this path must not fail even
      // if `isFabricValue()` itself has a defect, since throwing here would
      // replace the failure being reported rather than add to it. A hostile
      // proxy is the only way to provoke that from outside.
      const hostile = new Proxy({}, {
        get() {
          throw new Error("hostile");
        },
        getPrototypeOf() {
          throw new Error("hostile");
        },
        ownKeys() {
          throw new Error("hostile");
        },
      });

      const ps = new ProblematicValue("T@1", hostile, "boom");

      expect(typeof ps.state).toBe("string");
      expect(ps.error).toBe("boom");
    });

    it("renders values with no fabric representation at all", () => {
      for (const state of [new Map([["a", 1]]), new Set([1]), () => 1]) {
        expect(typeof new ProblematicValue("T@1", state, "b").state)
          .toBe("string");
      }
    });
  });

  describe("instance members", () => {
    describe("`[DEEP_FREEZE]` / `[IS_DEEP_FROZEN]`", () => {
      it("via dispatch: recurses state, freezes in place", () => {
        const child = { x: 1 };
        const pv = new ProblematicValue(
          "Bad@1",
          child,
          "oops",
        );
        const result = deepFreeze(pv);
        expect(result).toBe(pv);
        expect(Object.isFrozen(pv)).toBe(true);
        expect(Object.isFrozen(child)).toBe(true);
        expect(isDeepFrozenFabricValue(pv)).toBe(true);
      });

      it("via direct member invocation: recurses state, freezes in place", () => {
        const child = { x: 1 };
        const pv = new ProblematicValue(
          "Bad@1",
          child,
          "oops",
        );
        const result = pv[DEEP_FREEZE](subFreeze);
        expect(result).toBe(pv);
        expect(Object.isFrozen(pv)).toBe(true);
        expect(Object.isFrozen(child)).toBe(true);
        expect(pv[IS_DEEP_FROZEN](subIsDeepFrozen)).toBe(true);
      });
    });
  });

  describe("static members", () => {
    describe("[CODEC]", () => {
      describe("tagForValue()", () => {
        it("returns the value's own (per-instance) wire type tag", () => {
          const pv = new ProblematicValue("Weird@7", "s", "oops");
          expect(ProblematicValue[CODEC].tagForValue(pv)).toBe("Weird@7");
        });
      });

      describe("encode()", () => {
        it("returns the bare `state` (the tag is carried separately)", () => {
          const pv = new ProblematicValue("Weird@7", { x: 1 }, "oops");
          expect(ProblematicValue[CODEC].encode(pv)).toEqual({ x: 1 });
        });
      });
    });
  });
});
