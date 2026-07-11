import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { cloneIfNecessary, type CloneOptions } from "@/fabric-value.ts";
import type { FabricValue } from "@/fabric-value.ts";
import { isDeepFrozen, isDeepFrozenFabricValue } from "@/deep-freeze.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { FabricEpochDays } from "@/fabric-primitives/FabricEpochDays.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import { FabricHash } from "@/fabric-primitives/FabricHash.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import { FabricMap } from "@/fabric-instances/FabricMap.ts";
import { FabricSet } from "@/fabric-instances/FabricSet.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";
import { UnknownValue } from "@/fabric-instances/UnknownValue.ts";
import { FabricPrimitive, FabricSpecialObject } from "@/interface.ts";
import { registerFabricFactory } from "@/fabric-factory.ts";

const FACTORY_REF = {
  identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  symbol: "__cfFactory_1",
} as const;

describe("cloneIfNecessary", () => {
  describe("Fabric factories", () => {
    it("preserves one hardened factory atom for mutable and frozen requests", () => {
      const factories = [
        registerFabricFactory(() => undefined, "pattern", {
          kind: "pattern",
          rootToken: {},
          ref: FACTORY_REF,
          argumentSchema: true,
          resultSchema: true,
        }),
        registerFabricFactory(() => undefined, "module", {
          kind: "module",
          rootToken: {},
          ref: FACTORY_REF,
        }),
        registerFabricFactory(() => undefined, "handler", {
          kind: "handler",
          rootToken: {},
          ref: FACTORY_REF,
        }),
      ];

      for (const factory of factories) {
        expect(cloneIfNecessary(factory)).toBe(factory);
        expect(Object.isFrozen(factory)).toBe(true);
        expect(cloneIfNecessary(factory, { frozen: false })).toBe(factory);
        expect(
          cloneIfNecessary(factory, {
            frozen: false,
            deep: false,
            force: true,
          }),
        ).toBe(factory);
      }
    });

    it("fails before cloning a live factory whose artifact ref is unavailable", () => {
      const factory = registerFabricFactory(() => undefined, "handler", {
        kind: "handler",
        rootToken: {},
      });

      expect(() => cloneIfNecessary(factory)).toThrow(
        "artifact ref is not available",
      );
      expect(Object.isFrozen(factory)).toBe(false);
    });

    it("rejects an arbitrary function even when it is the same reference", () => {
      const fn = (() => undefined) as unknown as FabricValue;
      expect(() => cloneIfNecessary(fn)).toThrow("function");
    });
  });

  describe(`error cases`, () => {
    it("throws for `frozen=true`, `force=true`", () => {
      const value = { a: 1 } as FabricValue;
      expect(() => cloneIfNecessary(value, { frozen: true, force: true }))
        .toThrow("frozen: true, force: true");
    });

    it("throws for `frozen=false`, `force=false`, `deep=true`", () => {
      const value = { a: 1 } as FabricValue;
      expect(() => cloneIfNecessary(value, { frozen: false, force: false }))
        .toThrow("frozen: false, force: false, deep: true");
    });
  });

  describe(`default options`, () => {
    it("passes through primitives unchanged", () => {
      expect(cloneIfNecessary(42 as FabricValue)).toBe(42);
      expect(cloneIfNecessary("hello" as FabricValue)).toBe("hello");
      expect(cloneIfNecessary(null)).toBe(null);
      expect(cloneIfNecessary(true as FabricValue)).toBe(true);
      expect(cloneIfNecessary(undefined)).toBe(undefined);
    });

    it("passes through bigint unchanged", () => {
      expect(cloneIfNecessary(42n as FabricValue)).toBe(42n);
    });

    it("returns a frozen copy of an unfrozen object", () => {
      const value = { a: 1, b: "two" } as FabricValue;
      const result = cloneIfNecessary(value);
      expect(result).toEqual({ a: 1, b: "two" });
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("returns a frozen copy of an unfrozen array", () => {
      const value = [1, 2, 3] as FabricValue;
      const result = cloneIfNecessary(value);
      expect(result).toEqual([1, 2, 3]);
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("deep-freezes nested structures", () => {
      const value = { a: { b: [1, 2] } } as FabricValue;
      const result = cloneIfNecessary(value) as Record<string, unknown>;
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.a)).toBe(true);
      const inner = (result.a as Record<string, unknown>).b;
      expect(Object.isFrozen(inner)).toBe(true);
    });

    it("returns already-deep-frozen value as-is (identity optimization)", () => {
      const inner = Object.freeze([1, 2]);
      const value = Object.freeze({ a: inner }) as FabricValue;
      const result = cloneIfNecessary(value);
      expect(result).toBe(value); // identity -- no clone needed
    });

    it("preserves deep-frozen subtrees as-is within unfrozen parent", () => {
      // `frozenChild` is a deep-frozen subtree.
      const frozenChild = Object.freeze({ x: Object.freeze([1, 2]) });
      // `value` is NOT frozen (unfrozen parent), so it must be cloned.
      const value = { a: frozenChild, b: "mutable" } as FabricValue;
      const result = cloneIfNecessary(value) as Record<string, unknown>;
      // The outer object is a new frozen clone.
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(true);
      // The deep-frozen subtree is preserved by identity -- not re-cloned.
      expect(result.a).toBe(frozenChild);
      expect(result.b).toBe("mutable");
    });
  });

  describe(`\`frozen=false\`, deep clone`, () => {
    it("returns a mutable copy of a frozen object", () => {
      const value = Object.freeze({ a: 1, b: "two" }) as FabricValue;
      const result = cloneIfNecessary(value, { frozen: false });
      expect(result).toEqual({ a: 1, b: "two" });
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(false);
    });

    it("returns a mutable array copy", () => {
      const value = Object.freeze([1, 2, 3]) as FabricValue;
      const result = cloneIfNecessary(value, { frozen: false });
      expect(result).toEqual([1, 2, 3]);
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(false);
    });

    it("clones already-mutable values (`force=true` default)", () => {
      const inner = { x: 1 };
      const value = { a: inner, b: [2, 3] } as FabricValue;
      const result = cloneIfNecessary(value, { frozen: false }) as Record<
        string,
        unknown
      >;
      // Must be a different reference, even though input is already mutable.
      expect(result).not.toBe(value);
      expect(result).toEqual({ a: { x: 1 }, b: [2, 3] });
      expect(Object.isFrozen(result)).toBe(false);
      // Nested values are also cloned.
      expect(result.a).not.toBe(inner);
      expect(result.b).not.toBe((value as Record<string, unknown>).b);
    });

    it("deep-unfreezes nested structures", () => {
      const inner = Object.freeze([1, 2]);
      const value = Object.freeze({
        a: Object.freeze({ b: inner }),
      }) as FabricValue;
      const result = cloneIfNecessary(value, { frozen: false }) as Record<
        string,
        unknown
      >;
      expect(Object.isFrozen(result)).toBe(false);
      expect(Object.isFrozen(result.a)).toBe(false);
      const innerResult = (result.a as Record<string, unknown>).b;
      expect(Object.isFrozen(innerResult)).toBe(false);
    });
  });

  describe(`shallow clone`, () => {
    it("shallow-clones an unfrozen object to frozen", () => {
      const inner = { x: 1 };
      const value = { a: inner } as FabricValue;
      const result = cloneIfNecessary(value, { deep: false }) as Record<
        string,
        unknown
      >;
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(true);
      // Shallow: inner reference is preserved (not deep-cloned).
      expect(result.a).toBe(inner);
    });

    it("returns already-frozen object as-is (shallow, `force=false`)", () => {
      const value = Object.freeze({ a: 1 }) as FabricValue;
      const result = cloneIfNecessary(value, { deep: false });
      expect(result).toBe(value);
    });

    it("shallow-clones frozen object to mutable (`deep=false`, `frozen=false`)", () => {
      const value = Object.freeze({ a: 1, b: "two" }) as FabricValue;
      const result = cloneIfNecessary(value, {
        deep: false,
        frozen: false,
      }) as Record<string, unknown>;
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(false);
      expect(result.a).toBe(1);
    });

    it("force-copies mutable object (shallow, `frozen=false`, `force=true`)", () => {
      const value = { a: 1 } as FabricValue;
      const result = cloneIfNecessary(value, {
        deep: false,
        frozen: false,
      }); // force defaults to true for frozen=false
      expect(result).not.toBe(value);
      expect(result).toEqual({ a: 1 });
      expect(Object.isFrozen(result)).toBe(false);
    });

    it("returns mutable as-is (shallow, `frozen=false`, `force=false`)", () => {
      const value = { a: 1 } as FabricValue;
      const result = cloneIfNecessary(value, {
        deep: false,
        frozen: false,
        force: false,
      });
      expect(result).toBe(value);
    });

    it("thaws frozen value (shallow, `frozen=false`, `force=false`)", () => {
      const value = Object.freeze({ a: 1 }) as FabricValue;
      const result = cloneIfNecessary(value, {
        deep: false,
        frozen: false,
        force: false,
      });
      expect(result).not.toBe(value);
      expect(result).toEqual({ a: 1 });
      expect(Object.isFrozen(result)).toBe(false);
    });
  });

  describe(`\`FabricInstance\``, () => {
    it("identity-returns an already-deep-frozen `FabricError`", () => {
      // A `FabricError` with no `cause` or extras is deep-frozen as soon
      // as the wrapper is `Object.freeze`'d (the wrapper itself is the
      // canonical state). `cloneIfNecessary` therefore returns identity.
      const error = FabricError.fromNativeError(new Error("test"));
      Object.freeze(error);
      const result = cloneIfNecessary(error);
      expect(result).toBe(error);
      expect((result as FabricError).message).toBe("test");
    });

    it("deep-clones a `FabricError` with a mutable cause", () => {
      // Wrapper frozen but `cause` not -> not deep-frozen -> clone.
      const error = FabricError.fromNativeError(
        new Error("test", { cause: { mutable: true } }),
      );
      Object.freeze(error);
      const result = cloneIfNecessary(error);
      expect(result).toBeInstanceOf(FabricError);
      expect(result).not.toBe(error);
      expect(Object.isFrozen(result)).toBe(true);
      expect((result as FabricError).message).toBe("test");
    });

    it("produces a mutable `FabricError` clone (deep, `frozen=false`)", () => {
      // Deep clone with `frozen: false` yields a fresh *mutable*
      // `FabricError`.
      const error = FabricError.fromNativeError(new Error("test"));
      Object.freeze(error);
      const result = cloneIfNecessary(
        error as unknown as FabricValue,
        { frozen: false },
      );
      expect(result).toBeInstanceOf(FabricError);
      expect(result).not.toBe(error);
      expect(Object.isFrozen(result)).toBe(false);
      expect((result as FabricError).message).toBe("test");
    });

    it("preserves a nested already-deep-frozen `FabricError` by identity", () => {
      // Container is rebuilt (mutable input -> frozen output) but the
      // nested deep-frozen FabricError is returned by identity.
      const error = FabricError.fromNativeError(new Error("nested"));
      Object.freeze(error);
      const value = { err: error, x: 42 } as FabricValue;
      const result = cloneIfNecessary(value) as Record<string, unknown>;
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(true);
      expect(result.err).toBeInstanceOf(FabricError);
      expect(result.err).toBe(error);
      expect((result.err as FabricError).message).toBe("nested");
      expect(result.x).toBe(42);
    });

    it("shallow-clones an object containing a `FabricError` (`deep=false`)", () => {
      // Shallow clone of a container shares the nested instance by
      // reference -- it is never traversed or rebuilt.
      const error = FabricError.fromNativeError(new Error("nested"));
      const value = { err: error, x: 42 } as FabricValue;
      const result = cloneIfNecessary(value, { deep: false }) as Record<
        string,
        unknown
      >;
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(true);
      expect(result.err).toBe(error);
      expect(result.x).toBe(42);
    });
  });

  describe(`\`undefined\` preservation`, () => {
    it("preserves `undefined` in objects", () => {
      const value = { a: 1, b: undefined } as FabricValue;
      const result = cloneIfNecessary(value) as Record<string, unknown>;
      expect(result.b).toBe(undefined);
      expect("b" in result).toBe(true);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("preserves `undefined` in arrays", () => {
      const value = [1, undefined, 3] as FabricValue;
      const result = cloneIfNecessary(value) as unknown[];
      expect(result[1]).toBe(undefined);
      expect(1 in result).toBe(true);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("passes through `undefined` as top-level value", () => {
      expect(cloneIfNecessary(undefined, { frozen: false })).toBe(
        undefined,
      );
    });

    it("passes through `undefined` with default options", () => {
      expect(cloneIfNecessary(undefined)).toBe(undefined);
    });
  });

  describe(`\`null\` prototype preservation`, () => {
    it("preserves `null` prototype on objects", () => {
      const value = Object.create(null) as Record<string, unknown>;
      value.a = 1;
      value.b = "two";
      const result = cloneIfNecessary(
        value as FabricValue,
      ) as Record<string, unknown>;
      expect(Object.getPrototypeOf(result)).toBe(null);
      expect(result.a).toBe(1);
      expect(result.b).toBe("two");
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("preserves `null` prototype when `frozen=false`", () => {
      const value = Object.create(null) as Record<string, unknown>;
      value.x = 42;
      const result = cloneIfNecessary(
        value as FabricValue,
        { frozen: false },
      ) as Record<string, unknown>;
      expect(Object.getPrototypeOf(result)).toBe(null);
      expect(result.x).toBe(42);
      expect(Object.isFrozen(result)).toBe(false);
    });

    it("preserves `null` prototype on shallow clone", () => {
      const value = Object.create(null) as Record<string, unknown>;
      value.a = 1;
      const result = cloneIfNecessary(
        value as FabricValue,
        { deep: false },
      ) as Record<string, unknown>;
      expect(Object.getPrototypeOf(result)).toBe(null);
      expect(result.a).toBe(1);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("preserves `null` prototype on shallow clone when `frozen=false`", () => {
      const value = Object.create(null) as Record<string, unknown>;
      value.b = 2;
      const result = cloneIfNecessary(
        value as FabricValue,
        { frozen: false, deep: false },
      ) as Record<string, unknown>;
      expect(Object.getPrototypeOf(result)).toBe(null);
      expect(result.b).toBe(2);
      expect(Object.isFrozen(result)).toBe(false);
    });
  });

  describe(`\`FabricPrimitive\``, () => {
    it("passes through `FabricEpochNsec` unchanged", () => {
      const epoch = new FabricEpochNsec(1234567890n);
      Object.freeze(epoch);
      const result = cloneIfNecessary(epoch as unknown as FabricValue);
      expect(result).toBe(epoch); // identity -- special primitives are immutable
    });

    it("passes through `FabricEpochNsec` when `frozen=false`", () => {
      const epoch = new FabricEpochNsec(42n);
      Object.freeze(epoch);
      // frozen parameter is irrelevant for special primitives
      const result = cloneIfNecessary(
        epoch as unknown as FabricValue,
        { frozen: false },
      );
      expect(result).toBe(epoch); // identity -- special primitives are immutable
    });

    it("passes through `FabricEpochNsec` nested in an object", () => {
      const epoch = new FabricEpochNsec(999n);
      Object.freeze(epoch);
      const value = { time: epoch, label: "test" } as FabricValue;
      const result = cloneIfNecessary(value) as Record<string, unknown>;
      expect(Object.isFrozen(result)).toBe(true);
      expect(result.time).toBe(epoch); // same instance -- not cloned
      expect(result.label).toBe("test");
    });
  });

  describe(`circular reference detection`, () => {
    it("throws on direct circular object reference", () => {
      const obj = {} as Record<string, unknown>;
      obj.self = obj;
      expect(() => cloneIfNecessary(obj as FabricValue)).toThrow(
        "Cannot deep-clone circular reference",
      );
    });

    it("throws on circular array reference", () => {
      const arr: unknown[] = [1, 2];
      arr.push(arr);
      expect(() => cloneIfNecessary(arr as FabricValue)).toThrow(
        "Cannot deep-clone circular reference",
      );
    });

    it("throws on indirect circular reference", () => {
      const a = {} as Record<string, unknown>;
      const b = { parent: a } as Record<string, unknown>;
      a.child = b;
      expect(() => cloneIfNecessary(a as FabricValue)).toThrow(
        "Cannot deep-clone circular reference",
      );
    });

    it("handles shared (diamond) references without throwing", () => {
      const shared = { x: 1 };
      const value = { a: shared, b: shared } as FabricValue;
      // Shared (non-circular) references should not throw.
      const result = cloneIfNecessary(value) as Record<string, unknown>;
      expect(result).toEqual({ a: { x: 1 }, b: { x: 1 } });
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  // Per-subclass coverage matrix.
  //
  // Systematically exercises every concrete `FabricInstance` and
  // `FabricPrimitive` subclass in this package across the full `cloneIfNecessary`
  // option matrix, and validates the result -- frozenness, identity preservation,
  // observable state -- or that the call throws when a subclass's protocol
  // implementation is a documented stub.
  //
  // The point is twofold: (a) make sure existing subclasses behave consistently
  // under every option combination callers in production are likely to use, and
  // (b) make sure any future subclass added to the package without full protocol
  // coverage trips this matrix instead of silently breaking call sites.

  /**
   * Describes what `cloneIfNecessary` is expected to do for a given subclass on
   * a given option vector. `kind: "ok"` means the call returns; `kind: "throws"`
   * means it throws (we don't pin the exact message -- subclass stubs use
   * varying phrasing).
   */
  type ExpectedOutcome =
    | { kind: "ok" }
    | { kind: "throws" };

  /**
   * Per-subclass metadata that drives the matrix below.
   *
   * `deepCloneImplemented` indicates whether `deepClone(frozen)` is a real
   * implementation (not a stub or the inherited `FabricNativeWrapper.deepClone`
   * that throws). When false, `cloneIfNecessary` paths that fall through to
   * `deepClone()` will throw.
   *
   * Other distinctions (whether the subclass is a `FabricPrimitive`, whether
   * the deep-freeze protocol is implemented as a real impl vs. a stub) are
   * detected at test time -- the former via `instanceof FabricPrimitive` on the
   * factory output, the latter via `try/catch` around `isDeepFrozenFabricValue`
   * in the predicate.
   */
  type SubclassCase = {
    readonly name: string;
    // Returns either a `FabricInstance` (non-primitive cases) or a
    // `FabricPrimitive` (primitive cases). Both extend `FabricSpecialObject`.
    readonly factory: () => FabricSpecialObject;
    readonly deepCloneImplemented: boolean;
  };

  const subclassCases: readonly SubclassCase[] = [
    // `FabricInstance` with full protocol coverage.
    {
      name: "FabricError",
      factory: () => FabricError.fromNativeError(new Error("test")),
      deepCloneImplemented: true,
    },
    {
      name: "ProblematicValue",
      factory: () =>
        new ProblematicValue("Foo@1", "state-data" as FabricValue, "boom"),
      deepCloneImplemented: false,
    },
    {
      name: "UnknownValue",
      factory: () => new UnknownValue("Foo@1", "state-data" as FabricValue),
      deepCloneImplemented: false,
    },
    // `FabricInstance` with all-protocol stubs (only shallow works).
    {
      name: "FabricMap",
      factory: () =>
        new FabricMap(
          new Map<FabricValue, FabricValue>([[
            "k" as FabricValue,
            1 as FabricValue,
          ]]),
        ),
      deepCloneImplemented: false,
    },
    {
      name: "FabricSet",
      factory: () => new FabricSet(new Set<FabricValue>([1 as FabricValue])),
      deepCloneImplemented: false,
    },
    // `FabricPrimitive` subclasses (intrinsically immutable).
    {
      name: "FabricBytes",
      factory: () => new FabricBytes(new Uint8Array([1, 2, 3])),
      deepCloneImplemented: false,
    },
    {
      name: "FabricRegExp",
      factory: () => new FabricRegExp(/abc/g),
      deepCloneImplemented: false,
    },
    {
      name: "FabricEpochNsec",
      factory: () => new FabricEpochNsec(1234567890n),
      deepCloneImplemented: false,
    },
    {
      name: "FabricEpochDays",
      factory: () => new FabricEpochDays(42n),
      deepCloneImplemented: false,
    },
    {
      name: "FabricHash",
      factory: () => new FabricHash(new Uint8Array([1, 2, 3, 4]), "fid1"),
      deepCloneImplemented: false,
    },
  ];

  /**
   * Compute the expected outcome of a `cloneIfNecessary(value, opts)` call for
   * a given subclass, by inspecting the *actual* value to predict which
   * `cloneHelper` arm is reached. The point of computing rather than tabulating
   * is so that adding a new subclass to `subclassCases` (or changing what its
   * factory returns) keeps the test self-consistent automatically.
   *
   * Encodes the `cloneHelper` call-path logic:
   *
   *   1. `FabricPrimitive` subclasses are returned by identity unconditionally.
   *   2. For `FabricInstance`, `canReturnAsIs` short-circuits the call when
   *      the requested frozenness matches the input's frozenness AND
   *      `force: false`. In `deep: true` mode that check uses
   *      `isDeepFrozenFabricValue`, which invokes `[IS_DEEP_FROZEN]` on
   *      `FabricInstance` arms -- a subclass with a throwing stub for that
   *      member throws if the probe descends that far.
   *   3. Otherwise `cloneIfNecessary` falls through to `shallowClone(frozen)`
   *      (always implemented via `FabricInstance`'s base impl) or
   *      `deepClone(frozen)` (a throwing stub on subclasses that haven't
   *      implemented it yet).
   */
  function expectedOutcome(
    c: SubclassCase,
    value: FabricValue,
    opts: Required<CloneOptions>,
  ): ExpectedOutcome {
    // (1) `FabricPrimitive`: cloneHelper returns the value as-is.
    if (value instanceof FabricPrimitive) return { kind: "ok" };

    const { frozen, deep, force } = opts;

    // (2) `canReturnAsIs` short-circuit.
    if (!force) {
      let canReturnAsIs: boolean;
      if (deep) {
        // The check is `frozen && isDeepFrozenFabricValue(v)`. The latter may
        // call `[IS_DEEP_FROZEN]` on a `FabricInstance` arm -- if a subclass's
        // implementation is a throwing stub, the probe throws and propagates.
        if (!frozen) {
          canReturnAsIs = false;
        } else {
          try {
            canReturnAsIs = isDeepFrozenFabricValue(value);
          } catch {
            return { kind: "throws" };
          }
        }
      } else {
        // Shallow uses plain `Object.isFrozen`, no protocol call.
        canReturnAsIs = Object.isFrozen(value) === frozen;
      }
      if (canReturnAsIs) return { kind: "ok" };
    }

    // (3) Fell through to a clone method.
    if (deep) {
      if (!c.deepCloneImplemented) return { kind: "throws" };
    }
    // shallowClone is always implemented via the base class.
    return { kind: "ok" };
  }

  /**
   * The option vectors exercised against every subclass. We omit
   * `{ frozen: false, force: false, deep: true }` (rejected as ambiguous by
   * `cloneIfNecessary` itself) and `{ frozen: true, force: true, ... }`
   * (rejected as pointless). Those error cases are covered by the per-mode
   * `error cases` tests above.
   */
  const optionVectors: ReadonlyArray<{
    label: string;
    opts: Required<CloneOptions>;
  }> = [
    // Defaults
    {
      label: "defaults {frozen: true, deep: true, force: false}",
      opts: { frozen: true, deep: true, force: false },
    },
    // Deep, mutable result
    {
      label: "{frozen: false, deep: true, force: true}",
      opts: { frozen: false, deep: true, force: true },
    },
    // Shallow, frozen result, identity-when-possible
    {
      label: "{frozen: true, deep: false, force: false}",
      opts: { frozen: true, deep: false, force: false },
    },
    // Shallow, mutable result, always copy
    {
      label: "{frozen: false, deep: false, force: true}",
      opts: { frozen: false, deep: false, force: true },
    },
    // Shallow, mutable result, identity-when-possible (the spine-walk case)
    {
      label: "{frozen: false, deep: false, force: false}",
      opts: { frozen: false, deep: false, force: false },
    },
  ];

  describe("`cloneIfNecessary()`: subclass coverage matrix", () => {
    for (const c of subclassCases) {
      describe(c.name, () => {
        for (const inputFrozen of [false, true]) {
          const frozenLabel = inputFrozen ? "frozen input" : "mutable input";

          describe(frozenLabel, () => {
            for (const vec of optionVectors) {
              it(vec.label, () => {
                const value = c.factory();
                if (inputFrozen) Object.freeze(value);
                const ctor = value.constructor as new (
                  ...args: never[]
                ) => FabricSpecialObject;
                const wasFrozen = Object.isFrozen(value);

                const expected = expectedOutcome(
                  c,
                  value as unknown as FabricValue,
                  vec.opts,
                );

                if (expected.kind === "throws") {
                  expect(() =>
                    cloneIfNecessary(
                      value as unknown as FabricValue,
                      vec.opts,
                    )
                  ).toThrow();
                  return;
                }

                // Determine whether `cloneIfNecessary` should short-circuit
                // via `canReturnAsIs` -- which we mirror in the test for
                // identity assertions. This is the same logic as
                // `expectedOutcome`'s `canReturnAsIs` arm, restated here in
                // a form that doesn't presume an "ok" outcome.
                let identityExpected: boolean;
                if (vec.opts.force) {
                  identityExpected = false;
                } else if (vec.opts.deep) {
                  identityExpected = vec.opts.frozen &&
                    isDeepFrozenFabricValue(
                      value as unknown as FabricValue,
                    );
                } else {
                  identityExpected = wasFrozen === vec.opts.frozen;
                }

                const result = cloneIfNecessary(
                  value as unknown as FabricValue,
                  vec.opts,
                ) as FabricSpecialObject;

                // (1) Class identity is preserved.
                expect(result).toBeInstanceOf(ctor);

                // (2) `FabricPrimitive`: always returns the source by
                // identity; result is always frozen (constructor invariant).
                if (value instanceof FabricPrimitive) {
                  expect(result).toBe(value);
                  expect(Object.isFrozen(result)).toBe(true);
                  return;
                }

                // (3) Frozenness matches the requested `frozen` option.
                expect(Object.isFrozen(result)).toBe(vec.opts.frozen);

                // (4) Identity preservation matches the canReturnAsIs
                // prediction.
                if (identityExpected) {
                  expect(result).toBe(value);
                } else {
                  expect(result).not.toBe(value);
                }

                // (5) `isDeepFrozen` agrees on deep-frozen requests.
                if (vec.opts.deep && vec.opts.frozen) {
                  expect(isDeepFrozen(result as unknown)).toBe(true);
                }
              });
            }
          });
        }
      });
    }
  });
});
