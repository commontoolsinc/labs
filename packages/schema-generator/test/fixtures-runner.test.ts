import { expect } from "@std/expect";
import { ensureDir } from "@std/fs/ensure-dir";
import { dirname, resolve } from "@std/path";

import {
  createUnifiedDiff,
  defineFixtureSuite,
} from "@commontools/test-support/fixture-runner";
import { createSchemaTransformerV2 } from "../src/plugin.ts";
import { getTypeFromCode, normalizeSchema } from "./utils.ts";

interface SchemaResult {
  normalized: unknown;
  serialized: string;
}

const TYPE_NAME = "SchemaRoot";

defineFixtureSuite<SchemaResult, string>({
  suiteName: "Schema fixtures",
  rootDir: "./test/fixtures/schema",
  expectedPath: ({ stem }) => `${stem}.expected.json`,
  async execute(fixture) {
    return await runSchemaTransform(fixture.inputPath);
  },
  async loadExpected(fixture) {
    return await Deno.readTextFile(fixture.expectedPath);
  },
  async determinismCheck(actual, fixture) {
    const rerun = await runSchemaTransform(fixture.inputPath);
    expect(actual.serialized).toEqual(rerun.serialized);
  },
  compare(actual, expectedText, fixture) {
    let actualObj;
    let expectedObj;
    try {
      actualObj = JSON.parse(actual.serialized.trim());
      expectedObj = JSON.parse(expectedText.trim());
    } catch (error) {
      throw new Error(
        `JSON parsing failed for ${fixture.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const normalizedActual = normalizeArrayOrdering(actualObj);
    const normalizedExpected = normalizeArrayOrdering(expectedObj);

    try {
      expect(normalizedActual).toEqual(normalizedExpected);
    } catch {
      const diff = createUnifiedDiff(
        expectedText.trim(),
        actual.serialized.trim(),
      );
      const message = [
        "",
        `Fixture semantic mismatch for ${fixture.id}`,
        `Input:    ${resolve(fixture.inputPath)}`,
        `Expected: ${resolve(fixture.expectedPath)}`,
        "",
        "=== UNIFIED DIFF (expected vs actual) ===",
        diff,
        "",
        "=== PARSED OBJECTS ===",
        `Expected: ${JSON.stringify(normalizedExpected, null, 2)}`,
        `Actual:   ${JSON.stringify(normalizedActual, null, 2)}`,
      ].join("\n");
      throw new Error(message);
    }
  },
  async updateGolden(actual, fixture) {
    await writeText(fixture.expectedPath, actual.serialized);
  },
});

async function runSchemaTransform(inputPath: string): Promise<SchemaResult> {
  const code = await Deno.readTextFile(inputPath);
  const { type, checker, typeNode } = await getTypeFromCode(code, TYPE_NAME);
  const transformer = createSchemaTransformerV2();
  const normalized = normalizeSchema(transformer(type, checker, typeNode));
  const serialized = JSON.stringify(normalized, null, 2) + "\n";
  return { normalized, serialized };
}

async function writeText(path: string, data: string) {
  await ensureDir(dirname(path));
  await Deno.writeTextFile(path, data);
}

function normalizeArrayOrdering(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(normalizeArrayOrdering);
  }
  if (obj && typeof obj === "object") {
    const entries = Object.entries(obj as Record<string, unknown>)
      .map(([key, value]) => {
        if (key === "required" && Array.isArray(value)) {
          return [key, [...value].sort()];
        }
        return [key, normalizeArrayOrdering(value)];
      });
    return Object.fromEntries(entries);
  }
  return obj;
}
