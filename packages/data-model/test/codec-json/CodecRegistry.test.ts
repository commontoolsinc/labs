import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { Constructor } from "@commonfabric/utils/types";

import { toCompactDebugString } from "@/value-debug.ts";
import { CodecRegistry, SELF_REP } from "@/codec-json/CodecRegistry.ts";
import { BaseFabricCodec } from "@/codec-common/BaseFabricCodec.ts";
import type { ReconstructionContext } from "@/codec-common/interface.ts";
import { UnknownValue } from "@/fabric-instances/UnknownValue.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";
import { type FabricValue } from "@/interface.ts";
import { registerFabricFactory } from "@/fabric-factory.ts";

const FACTORY_REF = {
  identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  symbol: "__cfLift_1",
} as const;

/**
 * Test codec that matches a single pre-set value (by `===`) and records
 * whether `canEncode()` was consulted, so tests can distinguish the classMap
 * fast path from the linear-scan slow path. `encode`/`decode` are never
 * exercised by the registry, so they throw.
 */
class TestCodec extends BaseFabricCodec {
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
          example as FabricValue,
        );
        expect(registry.codecFromValue(example as FabricValue)).toBe(handler);
        // Only the class-matched codec is consulted -- there is no linear scan.
        expect(first.canEncodeCalled).toBe(false);
        expect(handler.canEncodeCalled).toBe(true);
        expect(last.canEncodeCalled).toBe(false);
      });

      it(`returns undefined for ${counterStr} (no ${sourceName} match)`, () => {
        const { first, handler, last, registry } = buildRegistry(
          cls,
          example as FabricValue,
        );
        expect(registry.codecFromValue(counter as FabricValue)).toBeUndefined();
        // A class miss consults no codec (no linear scan).
        expect(first.canEncodeCalled).toBe(false);
        expect(handler.canEncodeCalled).toBe(false);
        expect(last.canEncodeCalled).toBe(false);
      });
    }

    it("returns undefined for a null-prototype object", () => {
      const { registry } = buildRegistry(
        FabricRegExp,
        new FabricRegExp(/x/) as FabricValue,
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
      expect(registry.codecFromValue(42n)).toBe(codec);
      expect(registry.codecFromTag("Big@1")).toBe(codec);
    });

    it("returns undefined when the codec's `canEncode()` rejects", () => {
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
      expect(registry.codecFromValue(42)).toBe(codec); // codec match
      expect(registry.codecFromValue(99)).toBe(SELF_REP); // self-rep fallback
    });
  });

  describe("registerCallable()", () => {
    it("dispatches only admitted callable factories and registers their tag", () => {
      const factory = registerFabricFactory(() => undefined, "module", {
        kind: "module",
        ref: FACTORY_REF,
      });
      const codec = new TestCodec("Factory@1", undefined, factory);
      const registry = new CodecRegistry();
      registry.registerCallable(codec);

      expect(registry.codecFromValue(factory)).toBe(codec);
      expect(registry.codecFromTag("Factory@1")).toBe(codec);
      expect(registry.codecFromValue((() => undefined) as never))
        .toBeUndefined();
    });

    it("does not dispatch a function through constructor registration", () => {
      const fn = () => undefined;
      const codec = new TestCodec(
        "Function@1",
        Function as unknown as Constructor,
        fn as never,
      );
      const registry = new CodecRegistry();
      registry.register(codec);

      expect(registry.codecFromValue(fn as never)).toBeUndefined();
      expect(codec.canEncodeCalled).toBe(false);
    });
  });

  describe("codecFromTag()", () => {
    it("returns the codec registered under a tag", () => {
      const registry = new CodecRegistry();
      const codec = new TestCodec("Foo@1", undefined);
      registry.register(codec);
      expect(registry.codecFromTag("Foo@1")).toBe(codec);
    });

    it("returns undefined for an unregistered tag", () => {
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
      expect(registry.codecFromTag("Dup@1")).toBe(second);
    });
  });
});
