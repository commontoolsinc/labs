import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { walk } from "@std/fs/walk";
import { dirname, resolve } from "@std/path";
import { ensureDir } from "@std/fs/ensure-dir";

import { createSchemaTransformerV2 } from "../src/plugin.ts";
import { getTypeFromCode, normalizeSchema } from "./utils.ts";

interface FixtureConfig {
  directory: string; // under test/fixtures
  describe: string;
}

const configs: FixtureConfig[] = [
  { directory: "schema", describe: "Schema fixtures" },
];

// Small unified diff string for nicer failure output
function unifiedDiff(expected: string, actual: string): string {
  const e = expected.split("\n");
  const a = actual.split("\n");
  const max = Math.max(e.length, a.length);
  const lines: string[] = [];
  for (let i = 0; i < max; i++) {
    const el = e[i] ?? "";
    const al = a[i] ?? "";
    if (el === al) {
      lines.push(`  ${el}`);
    } else {
      if (el !== "") lines.push(`- ${el}`);
      if (al !== "") lines.push(`+ ${al}`);
    }
  }
  return lines.join("\n");
}

async function writeText(path: string, data: string) {
  await ensureDir(dirname(path));
  await Deno.writeTextFile(path, data);
}

// Collect fixtures at module load time
const allFixtures: Map<string, Array<{ name: string; input: string; expected: string }>> = new Map();

for (const cfg of configs) {
  const baseDir = `./test/fixtures/${cfg.directory}`;
  const fixtures: Array<{ name: string; input: string; expected: string }> = [];
  
  try {
    for await (const entry of walk(baseDir, { match: [/\.input\.ts$/] })) {
      const input = entry.path;
      const stem = input.replace(/\.input\.ts$/, "");
      const expected = `${stem}.expected.json`;
      const name = input.replace(`${baseDir}/`, "").replace(/\.input\.ts$/, "");
      fixtures.push({ name, input, expected });
    }
  } catch {
    // Directory might not exist
  }
  
  allFixtures.set(cfg.directory, fixtures);
}

// Generate test suites
for (const cfg of configs) {
  const fixtures = allFixtures.get(cfg.directory) || [];
  
  describe(cfg.describe, () => {
    it("has fixtures", () => {
      expect(fixtures.length).toBeGreaterThan(0);
    });

    for (const fixture of fixtures) {
      it(`matches expected for ${fixture.name}`, async () => {
        const code = await Deno.readTextFile(fixture.input);
        const typeName = "SchemaRoot"; // Convention: root type is named 'SchemaRoot'

        const gen = createSchemaTransformerV2();
        const { type, checker, typeNode } = getTypeFromCode(code, typeName);
        const obj1 = normalizeSchema(gen(type, checker, typeNode));
        const obj2 = normalizeSchema(gen(type, checker, typeNode));
        const s1 = JSON.stringify(obj1, null, 2) + "\n";
        const s2 = JSON.stringify(obj2, null, 2) + "\n";
        expect(s1).toEqual(s2); // determinism

        if (Deno.env.get("UPDATE_GOLDENS") === "1") {
          await writeText(fixture.expected, s1);
          return;
        }

        const expected = await Deno.readTextFile(fixture.expected);
        if (s1 !== expected) {
          const diff = unifiedDiff(expected, s1);
          const msg = [
            `\nFixture mismatch for ${fixture.name}`,
            `Input:    ${resolve(fixture.input)}`,
            `Expected: ${resolve(fixture.expected)}`,
            "\n=== UNIFIED DIFF (expected vs actual) ===\n" + diff,
          ].join("\n");
          throw new Error(msg);
        }
      });
    }
  });
}