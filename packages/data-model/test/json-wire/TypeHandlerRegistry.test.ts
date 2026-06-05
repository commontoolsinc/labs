import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toCompactDebugString } from "../../src/value-debug.ts";
import { TypeHandlerRegistry } from "../../src/json-wire/TypeHandlerRegistry.ts";
import type {
  JsonWireValue,
  TypeHandler,
  TypeHandlerCodec,
} from "../../src/json-wire/interface.ts";
import { UnknownValue } from "../../src/fabric-instances/UnknownValue.ts";
import { FabricRegExp } from "../../src/fabric-primitives/FabricRegExp.ts";
import {
  FabricInstance,
  type FabricValue,
  type ReconstructionContext,
} from "../../src/interface.ts";

/** Handy no-op `TypeHandler` base class for use in tests. */
class TestTypeHandler implements TypeHandler {
  #classSource: ((...args: any[]) => any) | undefined;
  #wireTypeTag: string | undefined;
  canSerializeCalled: boolean = false;
  valueToAccept: unknown = undefined;

  constructor(
    classSource: ((...args: any[]) => any) | undefined,
    wireTypeTag: string | undefined,
  ) {
    this.#classSource = classSource;
    this.#wireTypeTag = wireTypeTag;
  }

  get classSource(): ((...args: any[]) => any) | undefined {
    return this.#classSource;
  }

  get wireTypeTag() {
    return this.#wireTypeTag;
  }

  canSerialize(value: FabricValue): boolean {
    this.canSerializeCalled = true;

    const accept = this.valueToAccept;
    return (accept !== undefined) && (value === accept);
  }

  serialize(
    _value: FabricValue,
    _codec: TypeHandlerCodec,
    _recurse: (v: FabricValue) => JsonWireValue,
  ): JsonWireValue {
    throw new Error("Unimplemented.");
  }

  deserialize(
    _state: JsonWireValue,
    _runtime: ReconstructionContext,
    _recurse: (v: JsonWireValue) => FabricValue,
  ): FabricValue {
    throw new Error("Unimplemented.");
  }
}

describe("TypeHandlerRegistry", () => {
  describe("findSerializer()", () => {
    for (
      const [fastPath, classSource, example, counterExample] of [
        [true, Boolean, false, [1, 2, 3]],
        [true, BigInt, 914n, true],
        [true, Number, 123, "florp"],
        [true, String, "blorp", null],
        [true, Symbol, Symbol.for("bleep"), undefined],
        [true, FabricRegExp, new FabricRegExp(/123/), { a: "boop" }], // a `FabricPrimitive`
        [
          true,
          UnknownValue,
          new UnknownValue("Unk@12", { muffin: "corn" }),
          123n,
        ], // a `FabricInstance`
        [
          false,
          FabricInstance,
          new UnknownValue("Unk@34", { biscuit: "butter" }),
          null,
        ],
      ] as const
    ) {
      const sourceName = classSource.name;
      const exampleStr = toCompactDebugString(example);
      const counterStr = toCompactDebugString(counterExample);
      const handler = new TestTypeHandler(
        classSource as (...args: any[]) => any,
        undefined,
      );
      const firstHandler = new TestTypeHandler(undefined, undefined);
      const lastHandler = new TestTypeHandler(undefined, undefined);
      const registry = new TypeHandlerRegistry();

      handler.valueToAccept = example;

      // We register `firstHandler` and `lastHandler` so that they will bracket
      // the `handler` we care about, to detect slow-path usage.
      registry.register(firstHandler);
      registry.register(handler);
      registry.register(lastHandler);

      if (fastPath) {
        it(`given ${exampleStr}, finds registered ${sourceName} via fast path`, () => {
          expect(registry.findSerializer(example)).toBe(handler);
          expect(firstHandler.canSerializeCalled).toBe(false);
          expect(handler.canSerializeCalled).toBe(true);
          expect(lastHandler.canSerializeCalled).toBe(false);
        });
      } else {
        it(`given ${exampleStr}, finds registered ${sourceName} via slow path`, () => {
          expect(registry.findSerializer(example)).toBe(handler);
          expect(firstHandler.canSerializeCalled).toBe(true);
          expect(handler.canSerializeCalled).toBe(true);
          expect(lastHandler.canSerializeCalled).toBe(false);
        });
      }

      firstHandler.canSerializeCalled = false;
      handler.canSerializeCalled = false;
      lastHandler.canSerializeCalled = false;

      it(`does not find registered ${sourceName} given ${counterStr}`, () => {
        expect(registry.findSerializer(counterExample)).toBeUndefined();
        expect(firstHandler.canSerializeCalled).toBe(true);
        expect(handler.canSerializeCalled).toBe(true);
        expect(lastHandler.canSerializeCalled).toBe(true);
      });
    }
  });
});
