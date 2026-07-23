import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { findJsonUnfaithfulValues } from "@commonfabric/pure-json";

describe("findJsonUnfaithfulValues", () => {
  it("accepts JSON-faithful shapes", () => {
    // The whitelist: null, booleans, strings, finite numbers other than -0,
    // dense arrays of accepted values, plain objects of accepted values.
    const schema = {
      type: "object",
      properties: {
        n: { type: "number", default: -1, minimum: 0, maximum: 100 },
        z: { type: "number", default: 0 },
        s: { type: "string", default: "x" },
        flag: { type: "boolean", default: false },
        nothing: { type: "null", default: null },
        tags: { type: "array", default: ["a", "b"], items: { type: "string" } },
        nested: { type: "object", default: { deep: [1, 2, { k: "v" }] } },
      },
      required: ["n"],
    };
    expect(findJsonUnfaithfulValues(schema)).toEqual([]);
  });

  it("treats a bare boolean as faithful", () => {
    expect(findJsonUnfaithfulValues(true)).toEqual([]);
    expect(findJsonUnfaithfulValues(false)).toEqual([]);
  });

  it("catches each non-finite and signed zero", () => {
    for (const value of [NaN, Infinity, -Infinity, -0]) {
      const found = findJsonUnfaithfulValues({
        type: "number",
        default: value,
      });
      expect(found).toHaveLength(1);
      expect(found[0]!.pointer).toBe("/default");
    }
  });

  it("catches a bigint", () => {
    // JSON.stringify throws on a bigint; caught here so the failure names the
    // value rather than surfacing as an opaque serialization error.
    const found = findJsonUnfaithfulValues({ default: 42n });
    expect(found).toEqual([{
      pointer: "/default",
      reason: "bigint 42n (not representable)",
    }]);
  });

  it("catches undefined -- dropped, not a bad number", () => {
    // A blacklist of bad numbers would miss this: `{ default: undefined }`
    // serializes to `{}`, silently losing the default.
    const found = findJsonUnfaithfulValues({ default: undefined });
    expect(found).toHaveLength(1);
    expect(found[0]!.pointer).toBe("/default");
  });

  it("catches undefined inside an array (becomes null)", () => {
    const found = findJsonUnfaithfulValues({ default: [1, undefined, 3] });
    expect(found).toHaveLength(1);
    expect(found[0]!.pointer).toBe("/default/1");
  });

  it("catches a sparse array hole (becomes null)", () => {
    // deno-lint-ignore no-sparse-arrays -- a hole is exactly what is under test.
    const holed = [1, , 3];
    const found = findJsonUnfaithfulValues({ default: holed });
    expect(found).toHaveLength(1);
    expect(found[0]!.pointer).toBe("/default/1");
    expect(found[0]!.reason).toContain("hole");
  });

  it("catches symbol and function values", () => {
    expect(findJsonUnfaithfulValues({ a: Symbol("s") })).toHaveLength(1);
    expect(findJsonUnfaithfulValues({ a: () => 1 })).toHaveLength(1);
  });

  it("catches a symbol-keyed property", () => {
    const found = findJsonUnfaithfulValues({ [Symbol("s")]: 1, ok: 2 });
    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toContain("symbol-keyed");
  });

  it("catches a non-index property on an array", () => {
    // `JSON.stringify` serializes an array's indices only; an extra own
    // property is dropped. The indices themselves stay faithful.
    const withExtra = Object.assign([1, 2], { foo: 3 });
    const found = findJsonUnfaithfulValues({ default: withExtra });
    expect(found).toHaveLength(1);
    expect(found[0]!.pointer).toBe("/default/foo");
    expect(found[0]!.reason).toContain("non-index");
  });

  it("catches a toJSON hook, even non-enumerable", () => {
    // `toJSON` replaces the value before JSON sees its contents, so the walk
    // cannot certify what would be sent.
    expect(findJsonUnfaithfulValues({ a: 1, toJSON: () => 5 })).toHaveLength(1);

    const hidden: Record<string, unknown> = { a: 1 };
    Object.defineProperty(hidden, "toJSON", {
      value: () => 5,
      enumerable: false,
    });
    const found = findJsonUnfaithfulValues({ default: hidden });
    expect(found).toHaveLength(1);
    expect(found[0]!.pointer).toBe("/default");
    expect(found[0]!.reason).toContain("toJSON");
  });

  it("catches a non-plain object (a class instance)", () => {
    // A class instance keeps its data in private fields, so `JSON.stringify`
    // finds nothing to emit. Any class instance is rejected.
    class Holder {
      #data = 5;
      get() {
        return this.#data;
      }
    }
    const found = findJsonUnfaithfulValues({ default: new Holder() });
    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toContain("non-plain object");
  });

  it("reports a cycle, but not a shared reference", () => {
    // A shared subtree at sibling positions is fine -- JSON.stringify
    // duplicates it. Only an actual cycle throws, so only that is reported.
    const shared = { k: 1 };
    expect(findJsonUnfaithfulValues({ a: shared, b: shared })).toEqual([]);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const found = findJsonUnfaithfulValues(cyclic);
    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toContain("circular");
  });

  it("reaches nested values with correct pointers", () => {
    const found = findJsonUnfaithfulValues({
      properties: { cfg: { default: { ratio: NaN, offsets: [1, -0, 3] } } },
    });
    expect(found.map((p) => p.pointer).sort()).toEqual([
      "/properties/cfg/default/offsets/1",
      "/properties/cfg/default/ratio",
    ]);
  });

  it("escapes ~ and / in pointer tokens", () => {
    // RFC 6901: `~` -> `~0`, `/` -> `~1`. A property named `a/b` must not read
    // as two path steps.
    const found = findJsonUnfaithfulValues({ "a/b~c": NaN });
    expect(found[0]!.pointer).toBe("/a~1b~0c");
  });
});
