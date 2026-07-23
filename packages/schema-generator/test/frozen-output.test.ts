import { expect } from "@std/expect";
import { isDeepFrozen } from "@commonfabric/data-model/deep-freeze";

import { createSchemaTransformerV2 } from "../src/plugin.ts";
import { getTypeFromCode } from "./utils.ts";

// The generator deep-freezes each schema as it is formatted, so a generated
// schema -- and every subtree within it -- is immutable. This is what lets the
// value model's frozen-object hash cache reuse a subtree's hash across the
// repeated hashing that schema deduplication does, instead of recomputing it.

async function generate(code: string, typeName = "S") {
  const { type, checker } = await getTypeFromCode(code, typeName);
  return createSchemaTransformerV2().generateSchema(type, checker);
}

Deno.test("generated schema is deep-frozen", async () => {
  const schema = await generate(`
    interface S {
      a: string;
      b: number;
      c: { nested: boolean; items: string[] };
    }
  `);
  expect(isDeepFrozen(schema)).toBe(true);
});

Deno.test("a generated default (a nested value) is frozen too", async () => {
  const schema = await generate(`
    import { Default } from "commonfabric";
    interface S {
      x: Default<{ a: number; b: number }, { a: 1; b: 2 }>;
    }
  `);
  expect(isDeepFrozen(schema)).toBe(true);
});

Deno.test("a generated union schema is deep-frozen", async () => {
  const schema = await generate(`
    interface S {
      u: { kind: "a"; n: number } | { kind: "b"; s: string };
    }
  `);
  expect(isDeepFrozen(schema)).toBe(true);
});
