import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../src/plugin.ts";
import { asObjectSchema, getTypeFromCode } from "./utils.ts";

// The DEFAULT_MARKER brand payload carries V (the default VALUE's type) — see
// Default<> in packages/api/index.ts. These tests generate schemas from bare
// checker TYPES (no typeNode), the situation every capture/projection/
// instantiation path puts the generator in: the authored `Default<…>` alias
// node is gone, and the payload is the only surviving source of the value.
// A local replica of the alias is declared in each snippet — brand detection
// is name-based (`__@DEFAULT_MARKER…` escaped names), matching the formatters.
const DEFAULT_PRELUDE = `
  declare const DEFAULT_MARKER: unique symbol;
  type DefaultMarker<T> = { readonly [DEFAULT_MARKER]: T };
  type Default<T, V extends T = T> = (T & DefaultMarker<V>) | T;
`;

describe("brand-payload default recovery (expanded Default<T, V>)", () => {
  const transformer = createSchemaTransformerV2();

  it("recovers string literal defaults from the payload", async () => {
    const code = `${DEFAULT_PRELUDE}
      interface Settings {
        note: Default<string, "n/a">;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "Settings");
    const schema = asObjectSchema(transformer.generateSchema(type, checker));

    expect(schema.properties?.note).toEqual({
      type: "string",
      default: "n/a",
    });
  });

  it("recovers number and boolean literal defaults", async () => {
    const code = `${DEFAULT_PRELUDE}
      interface Settings {
        count: Default<number, 3>;
        flag: Default<boolean, true>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "Settings");
    const schema = asObjectSchema(transformer.generateSchema(type, checker));

    expect(schema.properties?.count).toEqual({ type: "number", default: 3 });
    expect(schema.properties?.flag).toEqual({
      type: "boolean",
      default: true,
    });
  });

  it("recovers defaults through generic instantiation", async () => {
    // The case no authored-AST recovery can serve: V is substituted through
    // a type parameter, so no declaration anywhere spells the literal next
    // to this property.
    const code = `${DEFAULT_PRELUDE}
      interface Tagged<V extends string> {
        note: Default<string, V>;
      }
      interface Holder {
        tagged: Tagged<"from-generic">;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "Holder");
    const schema = asObjectSchema(transformer.generateSchema(type, checker));

    const tagged = asObjectSchema(
      (schema.properties?.tagged ?? {}) as Record<string, unknown>,
    );
    expect(tagged.properties?.note).toEqual({
      type: "string",
      default: "from-generic",
    });
  });

  it("recovers tuple and object literal payloads", async () => {
    const code = `${DEFAULT_PRELUDE}
      interface Settings {
        tags: Default<string[], ["a", "b"]>;
        config: Default<{ retries: number }, { retries: 2 }>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "Settings");
    const schema = asObjectSchema(transformer.generateSchema(type, checker));

    expect((schema.properties?.tags as Record<string, unknown>).default)
      .toEqual(["a", "b"]);
    expect((schema.properties?.config as Record<string, unknown>).default)
      .toEqual({ retries: 2 });
  });

  it("bails to plain formatting for non-literal payloads", async () => {
    // One-arg form: V = T = string, which is not a literal — no default can
    // or should be emitted.
    const code = `${DEFAULT_PRELUDE}
      interface Settings {
        note: Default<string>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "Settings");
    const schema = asObjectSchema(transformer.generateSchema(type, checker));

    expect(schema.properties?.note).toEqual({ type: "string" });
  });
});

// The tests above generate from the INTERFACE, so each property carries its
// authored typeNode and flows through the node-based formatter. The cases
// below generate from the property TYPE with no node — forcing the expanded
// brand-payload path that capture shrinking / path lowering / projection put
// the generator in. A union-VALUED default (`boolean`, a literal union, a
// nullable) distributes the brand across several members; the path must agree
// the payload across all of them. Uses a faithful Default replica incl. the
// nullish arm.
const FAITHFUL_PRELUDE = `
  declare const DEFAULT_MARKER: unique symbol;
  type DefaultMarker<T> = { readonly [DEFAULT_MARKER]: T };
  type IsEmptyTuple<T> = T extends readonly unknown[]
    ? number extends T["length"] ? false
    : T["length"] extends 0 ? true
    : false
    : false;
  type Default<T, V extends T = T> = IsEmptyTuple<T> extends true
    ? T & DefaultMarker<V>
    : ([T] extends [null | undefined] ? DefaultMarker<V> : T & DefaultMarker<V>) | T;
`;

describe("brand-payload recovery on the expanded path (no typeNode)", () => {
  const transformer = createSchemaTransformerV2();

  async function schemaOfPropertyType(
    body: string,
  ): Promise<Record<string, unknown>> {
    const { type, checker } = await getTypeFromCode(
      `${FAITHFUL_PRELUDE}\n${body}`,
      "S",
    );
    const propType = checker.getTypeOfSymbol(type.getProperty("x")!);
    return transformer.generateSchema(propType, checker) as Record<
      string,
      unknown
    >;
  }

  it("recovers a boolean default whose brand distributes across true|false", async () => {
    // `Default<boolean, true>` expands to two branded members
    // (`true & marker<true>`, `false & marker<true>`); both pay `true`.
    // Regression: the single-branded guard dropped this entirely.
    const schema = await schemaOfPropertyType(
      `interface S { x: Default<boolean, true>; }`,
    );
    expect(schema).toEqual({ type: "boolean", default: true });
  });

  it("recovers a default whose value type is a literal union", async () => {
    const schema = await schemaOfPropertyType(
      `interface S { x: Default<"a" | "b", "a">; }`,
    );
    expect(schema.default).toBe("a");
    expect(schema.enum).toEqual(["a", "b"]);
  });

  it("recovers a null default on a nullable value type", async () => {
    const schema = await schemaOfPropertyType(
      `interface S { x: Default<string | null, null>; }`,
    );
    expect(schema.default).toBe(null);
  });

  it("recovers a non-null default on a nullable value type", async () => {
    const schema = await schemaOfPropertyType(
      `interface S { x: Default<string | null, "y">; }`,
    );
    expect(schema.default).toBe("y");
  });

  it("recovers the default when combined with another union member", async () => {
    const schema = await schemaOfPropertyType(
      `interface S { x: Default<string, "a"> | number; }`,
    );
    expect(schema.default).toBe("a");
  });

  it("bails (no default) when two distinct defaults disagree in one union", async () => {
    // `Default<"a">` and `Default<"b">` each contribute a branded member with
    // a DIFFERENT payload — ambiguous, must never resolve to a guess.
    const schema = await schemaOfPropertyType(
      `interface S { x: Default<"a"> | Default<"b">; }`,
    );
    expect(schema.default).toBeUndefined();
  });
});

// The payloads above are all literal TYPES, which the checker hands over
// directly. A `typeof SOME_CONST` payload naming an object or array cannot be
// carried that way — the values are recovered by reading the const's
// INITIALIZER off the AST. That reader has to cope with the two spellings a
// number can take beyond a bare literal: a sign prefix, and the non-finite
// globals. Both are ordinary values under the system-wide `Object.is` leaf
// contract, so both must arrive intact. (Node-based path: the property keeps
// its authored typeNode, which is what reaches the initializer reader.)
describe("defaults recovered from a `typeof CONST` initializer", () => {
  const transformer = createSchemaTransformerV2();

  async function defaultOfX(declarations: string): Promise<unknown> {
    const { type, checker } = await getTypeFromCode(
      `${DEFAULT_PRELUDE}\n${declarations}`,
      "S",
    );
    const schema = asObjectSchema(transformer.generateSchema(type, checker));
    return (schema.properties?.x as Record<string, unknown> | undefined)
      ?.default;
  }

  it("recovers negative numbers in an object initializer", async () => {
    const value = await defaultOfX(`
      const D = { sentinel: -1, ratio: -0.5, positive: 2 };
      interface S {
        x: Default<
          { sentinel: number; ratio: number; positive: number },
          typeof D
        >;
      }
    `);

    expect(value).toEqual({ sentinel: -1, ratio: -0.5, positive: 2 });
  });

  it("recovers negative numbers in an array initializer", async () => {
    // Positional damage is the risk here: an element the reader cannot
    // evaluate does not drop out, it becomes a hole in place.
    const value = await defaultOfX(`
      const D = [-1, 2, -3];
      interface S { x: Default<number[], typeof D>; }
    `);

    expect(value).toEqual([-1, 2, -3]);
  });

  it("recovers non-finite numbers and signed zero", async () => {
    const value = await defaultOfX(`
      const D = { nan: NaN, inf: Infinity, ninf: -Infinity, nzero: -0 };
      interface S {
        x: Default<
          { nan: number; inf: number; ninf: number; nzero: number },
          typeof D
        >;
      }
    `) as Record<string, number>;

    // Asserted leaf-by-leaf with Object.is: a structural comparison would let
    // -0 pass as 0, which is the very conflation under test.
    expect(Number.isNaN(value.nan)).toBe(true);
    expect(value.inf).toBe(Infinity);
    expect(value.ninf).toBe(-Infinity);
    expect(Object.is(value.nzero, -0)).toBe(true);
  });

  it("declines to fold a shadowed non-finite global", async () => {
    // `NaN` here names a local binding, not the global. Folding it to the
    // global would be silently wrong.
    //
    // `export {}` makes the snippet a module, which is what pattern sources
    // always are. Without it the snippet is a global script, where redeclaring
    // `NaN` is an error rather than a shadowing binding and the checker hands
    // back the library symbol — so there would be no shadowing left to test.
    const value = await defaultOfX(`
      export {};
      const NaN = 111;
      const D = { shadowed: NaN };
      interface S { x: Default<{ shadowed: number }, typeof D>; }
    `) as Record<string, unknown>;

    expect(Number.isNaN(value.shadowed)).toBe(false);
  });
});
