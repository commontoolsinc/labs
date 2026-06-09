import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { Constructor } from "@commonfabric/utils/types";

import { toCompactDebugString } from "@/value-debug.ts";
import { CodecRegistry, SELF_REP } from "@/json-wire/CodecRegistry.ts";
import { BaseFabricCodec } from "@/wire-common/BaseFabricCodec.ts";
import type { ReconstructionContext } from "@/wire-common/interface.ts";
import { UnknownValue } from "@/fabric-instances/UnknownValue.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";
import { FabricInstance, type FabricValue } from "@/interface.ts";

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
    wireTypeTag: string,
    uniqueHandledClass: Constructor | undefined,
    accept?: FabricValue,
  ) {
    super(wireTypeTag, uniqueHandledClass);
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
    _wireTypeTag: string,
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
      const { fastPath, classSource, example, counter } of [
        {
          fastPath: true,
          classSource: Boolean,
          example: false,
          counter: [1, 2, 3],
        },
        { fastPath: true, classSource: BigInt, example: 914n, counter: true },
        { fastPath: true, classSource: Number, example: 123, counter: "florp" },
        {
          fastPath: true,
          classSource: String,
          example: "blorp",
          counter: null,
        },
        {
          fastPath: true,
          classSource: Symbol,
          example: Symbol.for("bleep"),
          counter: undefined,
        },
        {
          fastPath: true,
          classSource: FabricRegExp, // a `FabricPrimitive`
          example: new FabricRegExp(/123/),
          counter: { a: "boop" },
        },
        {
          fastPath: true,
          classSource: UnknownValue, // a `FabricInstance`
          example: new UnknownValue("Unk@12", { muffin: "corn" }),
          counter: 123n,
        },
        {
          fastPath: false, // registered under a base class, so misses classMap
          classSource: FabricInstance,
          example: new UnknownValue("Unk@34", { biscuit: "butter" }),
          counter: null,
        },
      ] as const
    ) {
      const sourceName = classSource.name;
      const exampleStr = toCompactDebugString(example);
      const counterStr = toCompactDebugString(counter);
      const cls = classSource as unknown as Constructor;

      if (fastPath) {
        it(`given ${exampleStr}, finds the ${sourceName} codec via the fast path`, () => {
          const { first, handler, last, registry } = buildRegistry(
            cls,
            example as FabricValue,
          );
          expect(registry.codecFromValue(example as FabricValue)).toBe(handler);
          expect(first.canEncodeCalled).toBe(false);
          expect(handler.canEncodeCalled).toBe(true);
          expect(last.canEncodeCalled).toBe(false);
        });
      } else {
        it(`given ${exampleStr}, finds the ${sourceName} codec via the slow path`, () => {
          const { first, handler, last, registry } = buildRegistry(
            cls,
            example as FabricValue,
          );
          expect(registry.codecFromValue(example as FabricValue)).toBe(handler);
          expect(first.canEncodeCalled).toBe(true);
          expect(handler.canEncodeCalled).toBe(true);
          expect(last.canEncodeCalled).toBe(false);
        });
      }

      it(`returns undefined for ${counterStr} (no ${sourceName} match)`, () => {
        const { first, handler, last, registry } = buildRegistry(
          cls,
          example as FabricValue,
        );
        expect(registry.codecFromValue(counter as FabricValue)).toBeUndefined();
        expect(first.canEncodeCalled).toBe(true);
        expect(handler.canEncodeCalled).toBe(true);
        expect(last.canEncodeCalled).toBe(true);
      });
    }
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

    it('rejects `"object"`', () => {
      const registry = new CodecRegistry();
      expect(() =>
        registry.registerPrimitive("object", new TestCodec("X@1", undefined))
      ).toThrow('does not accept `"object"`');
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

    it('rejects `"object"`', () => {
      const registry = new CodecRegistry();
      expect(() => registry.registerSelfRep("object")).toThrow(
        'does not accept `"object"`',
      );
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
