import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricInstance, type FabricValue } from "@/interface.ts";
import {
  BaseFabricInstance,
  DEEP_CLONE_CORE,
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
  SHALLOW_UNFROZEN_CLONE,
} from "@/fabric-instances/BaseFabricInstance.ts";
import { deepFreeze, isDeepFrozen } from "@/deep-freeze.ts";

/**
 * Minimal `BaseFabricInstance` subclass used to exercise the template-method
 * behavior in isolation, independent of any production concrete subclass.
 * Counts clone-core invocations (`[SHALLOW_UNFROZEN_CLONE]()` and
 * `[DEEP_CLONE_CORE]()`) via a constructor-supplied counter (kept off the
 * instance so freezing doesn't block bookkeeping).
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

  protected [DEEP_CLONE_CORE](_frozen: boolean): Probe {
    this.counter.calls += 1;
    return new Probe(this.#tag, this.counter);
  }

  protected [SHALLOW_UNFROZEN_CLONE](): Probe {
    this.counter.calls += 1;
    return new Probe(this.#tag, this.counter);
  }
}

/**
 * A `Probe` variant carrying a nested mutable record, for the deep-clone
 * cases that need the shallow-frozen / deep-frozen distinction and nested
 * independence (which the payload-less `Probe` cannot express).
 */
class DeepProbe extends BaseFabricInstance {
  state: { n: number };

  constructor(state: { n: number }, readonly counter = { calls: 0 }) {
    super();

    this.state = state;
  }

  get wireTypeTag(): string {
    return "DeepProbe@1";
  }

  [DEEP_FREEZE](
    subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue {
    subFreeze(this.state as unknown as FabricValue);
    Object.freeze(this);
    return this as unknown as FabricValue;
  }

  [IS_DEEP_FROZEN](
    subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean {
    return Object.isFrozen(this) &&
      subIsDeepFrozen(this.state as unknown as FabricValue);
  }

  protected [DEEP_CLONE_CORE](_frozen: boolean): DeepProbe {
    this.counter.calls += 1;
    return new DeepProbe({ ...this.state }, this.counter);
  }

  protected [SHALLOW_UNFROZEN_CLONE](): DeepProbe {
    return new DeepProbe(this.state, this.counter);
  }
}

/**
 * A rogue direct subclass of `FabricInstance` that bypasses
 * `BaseFabricInstance` -- the shape the invariant forbids. Used only to witness
 * `isInstance()`'s enforcement throw; no production class is built this way.
 */
class RogueInstance extends FabricInstance {
  deepClone(_frozen: boolean): FabricInstance {
    throw new Error("not exercised here");
  }

  shallowClone(_frozen: boolean): FabricInstance {
    throw new Error("not exercised here");
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

  describe("isInstance()", () => {
    it("is `true` for a `BaseFabricInstance`", () => {
      expect(BaseFabricInstance.isInstance(new Probe("t"))).toBe(true);
    });

    it("is `false` for non-fabric values", () => {
      expect(BaseFabricInstance.isInstance(null)).toBe(false);
      expect(BaseFabricInstance.isInstance(42)).toBe(false);
      expect(BaseFabricInstance.isInstance("x")).toBe(false);
      expect(BaseFabricInstance.isInstance({})).toBe(false);
      expect(BaseFabricInstance.isInstance([])).toBe(false);
    });

    it("throws for a `FabricInstance` that is not a `BaseFabricInstance`", () => {
      expect(() => BaseFabricInstance.isInstance(new RogueInstance())).toThrow(
        "Shouldn't happen",
      );
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

  describe("deepClone()", () => {
    describe("when `frozen` is `true`", () => {
      it("returns `this` for an already-deep-frozen instance (no core call)", () => {
        const probe = deepFreeze(new DeepProbe({ n: 1 }));

        const result = probe.deepClone(true);

        expect(result).toBe(probe);
        expect(probe.counter.calls).toBe(0);
      });

      it("does NOT identity-return a merely-shallowly-frozen instance", () => {
        // Frozen instance slot, still-mutable nested state: not deep-frozen,
        // so the deep identity gate (`isDeepFrozen`, not `Object.isFrozen`)
        // must allocate rather than alias.
        const probe = new DeepProbe({ n: 1 });
        Object.freeze(probe);

        expect(Object.isFrozen(probe)).toBe(true);
        expect(isDeepFrozen(probe)).toBe(false);
        expect(probe.deepClone(true)).not.toBe(probe);
        expect(probe.counter.calls).toBe(1);
      });

      it("returns a new deep-frozen instance for an unfrozen one", () => {
        const probe = new DeepProbe({ n: 1 });

        const result = probe.deepClone(true);

        expect(result).not.toBe(probe);
        expect(isDeepFrozen(result)).toBe(true);
        // Original is left unfrozen.
        expect(Object.isFrozen(probe)).toBe(false);
        expect(probe.counter.calls).toBe(1);
      });
    });

    describe("when `frozen` is `false`", () => {
      it("returns a fresh mutable clone with independent nested state", () => {
        const probe = new DeepProbe({ n: 1 });

        const result = probe.deepClone(false) as DeepProbe;

        expect(result).not.toBe(probe);
        expect(Object.isFrozen(result)).toBe(false);
        expect(result.state).not.toBe(probe.state);
        result.state.n = 2;
        expect(probe.state.n).toBe(1);
      });

      it("allocates even from a deep-frozen original (identity gate is `frozen===true` only)", () => {
        const probe = deepFreeze(new DeepProbe({ n: 1 }));

        const result = probe.deepClone(false);

        expect(result).not.toBe(probe);
        expect(Object.isFrozen(result)).toBe(false);
        expect(probe.counter.calls).toBe(1);
      });
    });
  });
});
