import { assertEquals } from "@std/assert";

import { findJsonUnfaithfulValues } from "./json-faithfulness.ts";

Deno.test("findJsonUnfaithfulValues: accepts JSON-faithful shapes", () => {
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
  assertEquals(findJsonUnfaithfulValues(schema), []);
});

Deno.test("findJsonUnfaithfulValues: a boolean value is faithful", () => {
  assertEquals(findJsonUnfaithfulValues(true), []);
  assertEquals(findJsonUnfaithfulValues(false), []);
});

Deno.test("findJsonUnfaithfulValues: catches each non-finite and signed zero", () => {
  for (const value of [NaN, Infinity, -Infinity, -0]) {
    const found = findJsonUnfaithfulValues({ type: "number", default: value });
    assertEquals(found.length, 1);
    assertEquals(found[0]!.pointer, "/default");
  }
});

Deno.test("findJsonUnfaithfulValues: catches a bigint", () => {
  // JSON.stringify throws on a bigint; caught here so the failure names the
  // value rather than surfacing as an opaque serialization error.
  const found = findJsonUnfaithfulValues({ default: 42n });
  assertEquals(found, [{
    pointer: "/default",
    reason: "bigint 42n (not representable)",
  }]);
});

Deno.test("findJsonUnfaithfulValues: catches undefined -- dropped, not a bad number", () => {
  // A blacklist of bad numbers would miss this: `{ default: undefined }`
  // serializes to `{}`, silently losing the default.
  const found = findJsonUnfaithfulValues({ default: undefined });
  assertEquals(found.length, 1);
  assertEquals(found[0]!.pointer, "/default");
});

Deno.test("findJsonUnfaithfulValues: catches undefined inside an array (becomes null)", () => {
  const found = findJsonUnfaithfulValues({ default: [1, undefined, 3] });
  assertEquals(found.length, 1);
  assertEquals(found[0]!.pointer, "/default/1");
});

Deno.test("findJsonUnfaithfulValues: catches a sparse array hole (becomes null)", () => {
  // deno-lint-ignore no-sparse-arrays -- a hole is exactly what is under test.
  const holed = [1, , 3];
  const found = findJsonUnfaithfulValues({ default: holed });
  assertEquals(found.length, 1);
  assertEquals(found[0]!.pointer, "/default/1");
  assertEquals(found[0]!.reason.includes("hole"), true);
});

Deno.test("findJsonUnfaithfulValues: catches symbol and function values", () => {
  assertEquals(findJsonUnfaithfulValues({ a: Symbol("s") }).length, 1);
  assertEquals(findJsonUnfaithfulValues({ a: () => 1 }).length, 1);
});

Deno.test("findJsonUnfaithfulValues: catches a symbol-keyed property", () => {
  const found = findJsonUnfaithfulValues({ [Symbol("s")]: 1, ok: 2 });
  assertEquals(found.length, 1);
  assertEquals(found[0]!.reason.includes("symbol-keyed"), true);
});

Deno.test("findJsonUnfaithfulValues: catches a non-index property on an array", () => {
  // `JSON.stringify` serializes an array's indices only; an extra own property
  // is dropped. The indices themselves stay faithful.
  const withExtra = Object.assign([1, 2], { foo: 3 });
  const found = findJsonUnfaithfulValues({ default: withExtra });
  assertEquals(found.length, 1);
  assertEquals(found[0]!.pointer, "/default/foo");
  assertEquals(found[0]!.reason.includes("non-index"), true);
});

Deno.test("findJsonUnfaithfulValues: catches a toJSON hook, even non-enumerable", () => {
  // `toJSON` replaces the value before JSON sees its contents, so the walk
  // cannot certify what would be sent.
  assertEquals(
    findJsonUnfaithfulValues({ a: 1, toJSON: () => 5 }).length,
    1,
  );

  const hidden: Record<string, unknown> = { a: 1 };
  Object.defineProperty(hidden, "toJSON", {
    value: () => 5,
    enumerable: false,
  });
  const found = findJsonUnfaithfulValues({ default: hidden });
  assertEquals(found.length, 1);
  assertEquals(found[0]!.pointer, "/default");
  assertEquals(found[0]!.reason.includes("toJSON"), true);
});

Deno.test("findJsonUnfaithfulValues: catches a non-plain object (a class instance)", () => {
  // A class instance keeps its data in private fields, so `JSON.stringify`
  // finds nothing to emit. Any class instance is rejected.
  class Holder {
    #data = 5;
    get() {
      return this.#data;
    }
  }
  const found = findJsonUnfaithfulValues({ default: new Holder() });
  assertEquals(found.length, 1);
  assertEquals(found[0]!.reason.includes("non-plain object"), true);
});

Deno.test("findJsonUnfaithfulValues: reports a cycle, but not a shared reference", () => {
  // A shared subtree at sibling positions is fine -- JSON.stringify duplicates
  // it. Only an actual cycle throws, so only that is reported.
  const shared = { k: 1 };
  assertEquals(findJsonUnfaithfulValues({ a: shared, b: shared }), []);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const found = findJsonUnfaithfulValues(cyclic);
  assertEquals(found.length, 1);
  assertEquals(found[0]!.reason.includes("circular"), true);
});

Deno.test("findJsonUnfaithfulValues: reaches nested values with correct pointers", () => {
  const found = findJsonUnfaithfulValues({
    properties: { cfg: { default: { ratio: NaN, offsets: [1, -0, 3] } } },
  });
  assertEquals(found.map((p) => p.pointer).sort(), [
    "/properties/cfg/default/offsets/1",
    "/properties/cfg/default/ratio",
  ]);
});

Deno.test("findJsonUnfaithfulValues: escapes ~ and / in pointer tokens", () => {
  // RFC 6901: `~` -> `~0`, `/` -> `~1`. A property named `a/b` must not read as
  // two path steps.
  const found = findJsonUnfaithfulValues({ "a/b~c": NaN });
  assertEquals(found[0]!.pointer, "/a~1b~0c");
});
