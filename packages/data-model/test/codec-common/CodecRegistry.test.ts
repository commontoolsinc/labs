import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { Constructor } from "@commonfabric/utils/types";

import { toCompactDebugString } from "@/value-debug.ts";
import { CodecRegistry, SELF_REP } from "@/codec-common/CodecRegistry.ts";
import { BaseNonterminalCodec } from "@/codec-common/BaseNonterminalCodec.ts";
import type { ReconstructionContext } from "@/codec-common/interface.ts";
import { UnknownValue } from "@/fabric-instances/UnknownValue.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";
import { type FabricValue } from "@/interface.ts";

/**
 * Test codec that matches a single pre-set value (by `===`) and records
 * whether `canEncode()` was consulted, so tests can distinguish the classMap
 * fast path from the linear-scan slow path. `encode`/`decode` are never
 * exercised by the registry, so they throw.
 */
class TestCodec extends BaseNonterminalCodec {
  canEncodeCalled = false;
  readonly #accept: FabricValue | undefined;

  constructor(
    recognizedTypeTag: string,
    uniqueHandledClass: Constructor | undefined,
    accept?: FabricValue,
  ) {
    super(recognizedTypeTag, uniqueHandledClass);
    this.#accept = accept;
  }

  override canEncode(value: FabricValue): boolean {
    this.canEncodeCalled = true;
    return (this.#accept !== undefined) && (value === this.#accept);
  }

  encode(_value: FabricValue): FabricValue {
    throw new Error("Unimplemented.");
  }

  decode(
    _typeTag: string,
    _state: FabricValue,
    _context: ReconstructionContext,
  ): FabricValue {
    throw new Error("Unimplemented.");
  }
}

/**
 * Builds a fresh registry with the codec-under-test bracketed by two
 * never-matching codecs, so a test can detect whether the linear scan ran.
 */
function buildRegistry(
  classSource: Constructor | undefined,
  example: FabricValue,
) {
  const first = new TestCodec("first@1", undefined);
  const handler = new TestCodec("handler@1", classSource, example);
  const last = new TestCodec("last@1", undefined);
  const registry = new CodecRegistry();
  registry.register(first);
  registry.register(handler);
  registry.register(last);
  return { first, handler, last, registry };
}

describe("CodecRegistry", () => {
  describe("codecFromValue()", () => {
    for (
      const { classSource, example, counter } of [
        { classSource: Boolean, example: false, counter: [1, 2, 3] },
        { classSource: BigInt, example: 914n, counter: true },
        { classSource: Number, example: 123, counter: "florp" },
        { classSource: String, example: "blorp", counter: null },
        {
          classSource: Symbol,
          example: Symbol.for("bleep"),
          counter: undefined,
        },
        {
          classSource: FabricRegExp, // a `FabricPrimitive`
          example: new FabricRegExp(/123/),
          counter: { a: "boop" },
        },
        {
          classSource: UnknownValue, // a `FabricInstance`
          example: new UnknownValue("Unk@12", { muffin: "corn" }),
          counter: 123n,
        },
      ] as const
    ) {
      const sourceName = classSource.name;
      const exampleStr = toCompactDebugString(example);
      const counterStr = toCompactDebugString(counter);
      const cls = classSource as unknown as Constructor;

      it(`given ${exampleStr}, finds the ${sourceName} codec by class`, () => {
        const { first, handler, last, registry } = buildRegistry(
          cls,
          example,
        );
        expect(registry.codecFromValue(example)).toEqual({
          nonterminal: handler,
        });
        // Only the class-matched codec is consulted -- there is no linear scan.
        expect(first.canEncodeCalled).toBe(false);
        expect(handler.canEncodeCalled).toBe(true);
        expect(last.canEncodeCalled).toBe(false);
      });

      it(`returns undefined for ${counterStr} (no ${sourceName} match)`, () => {
        const { first, handler, last, registry } = buildRegistry(
          cls,
          example,
        );
        expect(registry.codecFromValue(counter)).toBeUndefined();
        // A class miss consults no codec (no linear scan).
        expect(first.canEncodeCalled).toBe(false);
        expect(handler.canEncodeCalled).toBe(false);
        expect(last.canEncodeCalled).toBe(false);
      });
    }

    it("returns `undefined` for a `null`-prototype object", () => {
      const { registry } = buildRegistry(
        FabricRegExp,
        new FabricRegExp(/x/),
      );
      const nullProto = Object.create(null) as Record<string, FabricValue>;
      nullProto.a = 1;

      expect(registry.codecFromValue(nullProto)).toBeUndefined();
    });
  });

  describe("registerPrimitive()", () => {
    it("dispatches a primitive value to its codec (encode + decode)", () => {
      const registry = new CodecRegistry();
      const codec = new TestCodec("Big@1", undefined, 42n);
      registry.registerPrimitive("bigint", codec);
      expect(registry.codecFromValue(42n)).toEqual({ nonterminal: codec });
      expect(registry.codecFromTag("Big@1")).toEqual({ nonterminal: codec });
    });

    it("returns `undefined` when the codec's `canEncode()` says no", () => {
      const registry = new CodecRegistry();
      registry.registerPrimitive(
        "bigint",
        new TestCodec("Big@1", undefined, 42n),
      );
      expect(registry.codecFromValue(99n)).toBeUndefined();
    });
  });

  describe("registerSelfRep()", () => {
    it("returns `SELF_REP` for a self-representing primitive value", () => {
      const registry = new CodecRegistry();
      registry.registerSelfRep("string");
      expect(registry.codecFromValue("hi")).toBe(SELF_REP);
    });

    it("tries the type's codec before falling to self-rep", () => {
      const registry = new CodecRegistry();
      const codec = new TestCodec("Num@1", undefined, 42);
      registry.registerPrimitive("number", codec);
      registry.registerSelfRep("number");
      expect(registry.codecFromValue(42)).toEqual({ nonterminal: codec }); // codec match
      expect(registry.codecFromValue(99)).toBe(SELF_REP); // self-rep fallback
    });
  });

  describe("`extend()`", () => {
    it("returns a different instance", () => {
      const base = new CodecRegistry();
      expect(base.extend()).not.toBe(base);
    });

    it("returns a frozen instance", () => {
      expect(Object.isFrozen(new CodecRegistry().extend())).toBe(true);
    });

    it("carries over every kind of registration the base holds", () => {
      const base = new CodecRegistry();
      const codec = new TestCodec("carried@1", undefined);
      const primitive = new TestCodec("prim@1", undefined);
      base.register(codec);
      base.registerPrimitive("bigint", primitive);
      base.registerSelfRep("string");

      const extended = base.extend();

      expect(extended.codecFromTag("carried@1")).toEqual({
        nonterminal: codec,
      });
      expect(extended.codecFromTag("prim@1")).toEqual({
        nonterminal: primitive,
      });
      expect(extended.codecFromValue("florp")).toBe(SELF_REP);
    });

    it("registers a codec given on its own", () => {
      const added = new TestCodec("added@1", undefined);
      const extended = new CodecRegistry().extend(added);

      expect(extended.codecFromTag("added@1")).toEqual({ nonterminal: added });
    });

    it("registers codecs given individually and in lists, in any mix", () => {
      const loose = new TestCodec("loose@1", undefined);
      const listed = new TestCodec("listed@1", undefined);
      const alsoListed = new TestCodec("alsoListed@1", undefined);

      const extended = new CodecRegistry()
        .extend(loose, [listed, alsoListed]);

      expect(extended.codecFromTag("loose@1")).toEqual({ nonterminal: loose });
      expect(extended.codecFromTag("listed@1")).toEqual({
        nonterminal: listed,
      });
      expect(extended.codecFromTag("alsoListed@1")).toEqual({
        nonterminal: alsoListed,
      });
    });

    it("leaves the base without the added registrations", () => {
      const base = new CodecRegistry();
      base.extend(new TestCodec("added@1", undefined));

      expect(base.codecFromTag("added@1")).toBe(undefined);
    });
  });

  describe("frozen instances", () => {
    // `Object.freeze()` cannot reach a private `Map` or `Set`, so each mutator
    // has to refuse on its own; these cases pin that each one does.
    it("`register()` throws", () => {
      const registry = Object.freeze(new CodecRegistry());
      expect(() => registry.register(new TestCodec("nope@1", undefined)))
        .toThrow("Cannot modify frozen `CodecRegistry`");
    });

    it("`registerPrimitive()` throws", () => {
      const registry = Object.freeze(new CodecRegistry());
      expect(() =>
        registry.registerPrimitive("bigint", new TestCodec("nope@1", undefined))
      ).toThrow("Cannot modify frozen `CodecRegistry`");
    });

    it("`registerSelfRep()` throws", () => {
      const registry = Object.freeze(new CodecRegistry());
      expect(() => registry.registerSelfRep("string"))
        .toThrow("Cannot modify frozen `CodecRegistry`");
    });

    it("still answers lookups", () => {
      const base = new CodecRegistry();
      const codec = new TestCodec("readable@1", undefined);
      base.register(codec);
      Object.freeze(base);

      expect(base.codecFromTag("readable@1")).toEqual({ nonterminal: codec });
    });
  });

  describe("codecFromTag()", () => {
    it("returns the codec registered under a tag", () => {
      const registry = new CodecRegistry();
      const codec = new TestCodec("Foo@1", undefined);
      registry.register(codec);
      expect(registry.codecFromTag("Foo@1")).toEqual({ nonterminal: codec });
    });

    it("returns `undefined` for an unregistered tag", () => {
      const registry = new CodecRegistry();
      registry.register(new TestCodec("Foo@1", undefined));
      expect(registry.codecFromTag("Bar@2")).toBeUndefined();
    });

    it("resolves the last registration when a tag is reused", () => {
      const registry = new CodecRegistry();
      const first = new TestCodec("Dup@1", undefined);
      const second = new TestCodec("Dup@1", undefined);
      registry.register(first);
      registry.register(second);
      expect(registry.codecFromTag("Dup@1")).toEqual({ nonterminal: second });
    });
  });
});
