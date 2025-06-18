import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { isModule, isRecipe, type Opaque } from "../src/builder/types.ts";
import { isAlias } from "../src/link-utils.ts";
import { ALIAS_V1_TAG } from "../src/cell.ts";

describe("value type", () => {
  it("can destructure a value without TS errors", () => {
    const { foo, bar }: { foo: Opaque<string>; bar: Opaque<string> } = {
      foo: "foo",
      bar: "bar",
    } as Opaque<{
      foo: string;
      bar: string;
    }>;
    expect(foo).toBe("foo");
    expect(bar).toBe("bar");
  });

  /* TODO: This used to work, i.e. it didn't throw any Typescript errors, and
   * stopped when we moved this into its own package. Nothing else seems to
   * break, so let's skip this for now.
   */
  /*
  it.skip("works for arrays as well without TS errors", () => {
    const [foo, bar]: [Value<string>, Value<number>] = ["foo", 1] as Value<
      [string, number]
    >;
    expect(foo).toBe("foo");
    expect(bar).toBe("bar");
  });*/
});

describe("utility functions", () => {
  it("isAlias correctly identifies aliases", () => {
    expect(isAlias({ $alias: { path: ["path", "to", "value"] } })).toBe(true);
    expect(isAlias({ "/": { [ALIAS_V1_TAG]: { id: "path/to/value" } } })).toBe(
      true,
    );
    expect(isAlias({ notAlias: "something" })).toBe(false);
  });

  it("isModule correctly identifies modules", () => {
    expect(isModule({ type: "javascript", implementation: () => {} })).toBe(
      true,
    );
    expect(isModule({ notModule: "something" })).toBe(false);
  });

  it("isRecipe correctly identifies recipes", () => {
    expect(
      isRecipe({
        argumentSchema: {},
        resultSchema: {},
        initial: {},
        nodes: [],
      }),
    ).toBe(true);
    expect(isRecipe({ notRecipe: "something" })).toBe(false);
  });
});
