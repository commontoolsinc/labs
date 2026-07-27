import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { StaticCacheFS } from "@commonfabric/static";
import {
  FabricInstance,
  FabricPrimitive,
  FabricSpecialObject,
} from "@commonfabric/data-model/fabric-value";
import { FabricLink } from "@commonfabric/data-model/fabric-instances";
import {
  FabricBytes,
  FabricEpochDays,
  FabricEpochNsec,
  FabricHash,
} from "@commonfabric/data-model/fabric-primitives";
import { createBuilder } from "../src/builder/factory.ts";

// The Fabric value classes reach pattern code as `export declare const`s in
// `api/index.ts`, but the runtime values behind those declarations are bound
// separately, in `builder/factory.ts`. The two sides are maintained by hand, so
// a class can be declared without being bound -- which type-checks when the
// pattern is compiled and then fails once it actually runs. These tests pin the
// runtime half against the declared half.
//
// `types/commonfabric.d.ts` is a symlink to `api/index.ts`, and is the exact
// artifact the sandbox hands a pattern as its view of `commonfabric`. Deriving
// the expected names from it means this test tracks the real declarations
// rather than a hand-copied list that someone has to remember to extend.
const patternVisibleTypes = await new StaticCacheFS().getText(
  "types/commonfabric.d.ts",
);
const declaredClasses = [
  ...patternVisibleTypes.matchAll(/^export declare const (Fabric\w+)/gm),
].map((match) => match[1]);

// The `data-model` classes the bindings are expected to be. Listed explicitly
// rather than looked up by name in the spread module namespaces: the classes
// come from three different modules, and a name missing from all of them would
// compare `undefined` to `undefined` and pass without asserting anything.
const expectedBindings: Record<string, unknown> = {
  FabricSpecialObject,
  FabricInstance,
  FabricPrimitive,
  FabricEpochNsec,
  FabricEpochDays,
  FabricHash,
  FabricLink,
  FabricBytes,
};

describe("commonfabric Fabric value classes", () => {
  // Viewed as a plain record on purpose: the question here is what the builder
  // surface carries at runtime, which is exactly what its static type cannot
  // answer.
  const commonfabric = createBuilder().commonfabric as unknown as Record<
    string,
    unknown
  >;

  describe("runtime bindings", () => {
    // Without this, a derivation that matched nothing would leave every check
    // below vacuously passing.
    it("derives a non-empty class list from the pattern-visible types", () => {
      expect(declaredClasses.length).toBeGreaterThan(0);
    });

    for (const name of declaredClasses) {
      // Presence, not constructibility: `FabricSpecialObject` is abstract, and
      // exists at runtime so that `instanceof` works rather than so that it can
      // be `new`-ed. Constructibility is checked per-class below.
      it(`exposes \`${name}\` as a runtime value on the pattern surface`, () => {
        expect(typeof commonfabric[name]).toBe("function");
      });

      it(`binds \`${name}\` to the \`data-model\` class itself`, () => {
        expect(commonfabric[name]).toBe(expectedBindings[name]);
      });
    }
  });

  describe("FabricBytes", () => {
    it("constructs an instance that round-trips its bytes", () => {
      const BoundFabricBytes = commonfabric.FabricBytes as typeof FabricBytes;
      const bytes = new Uint8Array([1, 2, 3, 253, 254, 255]);
      const instance = new BoundFabricBytes(bytes);

      expect(instance).toBeInstanceOf(FabricBytes);
      expect(instance.length).toBe(6);
      expect(instance.slice()).toEqual(bytes);
    });
  });

  describe("FabricLink", () => {
    it("constructs an instance that retains its payload", () => {
      const BoundFabricLink = commonfabric.FabricLink as typeof FabricLink;
      const payload = { id: "of:example", path: ["a", "b"] };
      const instance = new BoundFabricLink(payload);

      expect(instance).toBeInstanceOf(FabricLink);
      expect(instance.payload).toEqual(payload);
    });
  });

  describe("FabricSpecialObject", () => {
    it("is usable as the right-hand side of `instanceof`", () => {
      const BoundFabricSpecialObject = commonfabric
        .FabricSpecialObject as typeof FabricSpecialObject;

      // The `instanceof` operator rather than `toBeInstanceOf()`, which does
      // not accept an abstract constructor. This is also the expression a
      // pattern would itself write.
      const instance = new FabricBytes(new Uint8Array([1]));

      expect(instance instanceof BoundFabricSpecialObject).toBe(true);
      expect({} instanceof BoundFabricSpecialObject).toBe(false);
    });
  });
});
