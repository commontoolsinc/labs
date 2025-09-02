import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { GOLDEN_CASES } from "./cases.ts";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import { getTypeFromCode, normalizeSchema } from "../utils.ts";
import { ensureDir } from "@std/fs";

async function readJson(path: string): Promise<unknown> {
  const text = await Deno.readTextFile(path);
  return JSON.parse(text);
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await ensureDir(path.split("/").slice(0, -1).join("/"));
  await Deno.writeTextFile(path, JSON.stringify(data, null, 2) + "\n");
}

describe("Golden snapshot runner", () => {
  for (const c of GOLDEN_CASES) {
    it(`matches golden for ${c.name}`, async () => {
      const gen = createSchemaTransformerV2();
      const { type, checker, typeNode } = getTypeFromCode(c.code, c.typeName);
      const actual1 = normalizeSchema(gen(type, checker, typeNode));
      const actual2 = normalizeSchema(gen(type, checker, typeNode));

      // Determinism: two runs must match
      expect(actual1).toEqual(actual2);

      if (Deno.env.get("UPDATE_GOLDENS") === "1") {
        await writeJson(c.expectedPath, actual1);
        return;
      }
      const expected = normalizeSchema(await readJson(c.expectedPath));
      try {
        expect(actual1).toEqual(expected);
      } catch (e) {
        // deno-lint-ignore no-console
        console.log(`\n--- GOLDEN DIFF (${c.name}) ---`);
        // deno-lint-ignore no-console
        console.log("ACTUAL:", JSON.stringify(actual1, null, 2));
        // deno-lint-ignore no-console
        console.log("EXPECTED:", JSON.stringify(expected, null, 2));
        throw e;
      }
    });
  }
});
