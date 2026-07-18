import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricInstance, type FabricValue } from "@/interface.ts";
import {
  BaseFabricInstance,
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
} from "@/fabric-instances/BaseFabricInstance.ts";

/**
 * Minimal `BaseFabricInstance` subclass used to exercise the template-method
 * behavior in isolation, independent of any production concrete subclass.
 * Counts `shallowUnfrozenClone()` invocations via a constructor-supplied
 * counter (kept off the instance so freezing doesn't block bookkeeping).
 */
class Probe extends BaseFabricInstance {
  readonly #tag;

  constructor(
    tag: string,
    readonly counter: { calls: number } = { calls: 0 },
  ) {
    super();

    this.#tag = tag;
  }

  get wireTypeTag(): string {
    return this.#tag;
  }

  [DEEP_FREEZE](
    _subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue {
    Object.freeze(this);
    return this as unknown as FabricValue;
  }

  [IS_DEEP_FROZEN](
    _subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean {
    return Object.isFrozen(this);
  }

  deepClone(_frozen: boolean): Probe {
    throw new Error("not exercised here");
  }

  protected shallowUnfrozenClone(): Probe {
    this.counter.calls += 1;
    return new Probe(this.#tag, this.counter);
  }
}

describe("BaseFabricInstance", () => {
  describe("inheritance", () => {
    it("is a subclass of `FabricInstance`", () => {
      const probe = new Probe("t");
      expect(probe instanceof BaseFabricInstance).toBe(true);
      expect(probe instanceof FabricInstance).toBe(true);
    });
  });

  describe("shallowClone()", () => {
    describe("when `frozen` is `true`", () => {
      it("returns `this` for an already-frozen instance (no clone call)", () => {
        const probe = new Probe("t");
        Object.freeze(probe);

        const result = probe.shallowClone(true);

        expect(result).toBe(probe);
        expect(probe.counter.calls).toBe(0);
      });

      it("returns a new frozen instance for an unfrozen one", () => {
        const probe = new Probe("t");

        const result = probe.shallowClone(true);

        expect(result).not.toBe(probe);
        expect(result instanceof Probe).toBe(true);
        expect((result as Probe).wireTypeTag).toBe("t");
        expect(Object.isFrozen(result)).toBe(true);
        // Original is left unfrozen.
        expect(Object.isFrozen(probe)).toBe(false);
        expect(probe.counter.calls).toBe(1);
      });
    });

    describe("when `frozen` is `false`", () => {
      it("returns a new unfrozen instance from a frozen original", () => {
        const probe = new Probe("t");
        Object.freeze(probe);

        const result = probe.shallowClone(false);

        expect(result).not.toBe(probe);
        expect(result instanceof Probe).toBe(true);
        expect((result as Probe).wireTypeTag).toBe("t");
        expect(Object.isFrozen(result)).toBe(false);
        // The identity-when-frozen optimization is `frozen===true` only;
        // a `frozen===false` call always allocates.
      });

      it("returns a new unfrozen instance from an unfrozen original", () => {
        const probe = new Probe("t");

        const result = probe.shallowClone(false);

        expect(result).not.toBe(probe);
        expect(Object.isFrozen(result)).toBe(false);
        expect(probe.counter.calls).toBe(1);
      });
    });
  });
});
