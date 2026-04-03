import { expect } from "@std/expect";
import { ensureDir } from "@std/fs/ensure-dir";
import { dirname, resolve } from "@std/path";
import ts from "typescript";

import {
  createUnifiedDiff,
  defineFixtureSuite,
} from "@commontools/test-support/fixture-runner";
import { createSchemaTransformerV2 } from "../src/plugin.ts";
import {
  batchTypeCheckFixtures,
  getTypeFromCode,
  normalizeSchema,
} from "./utils.ts";

interface SchemaResult {
  normalized: unknown;
  serialized: string;
}

const TYPE_NAME = "SchemaRoot";
const FIXTURES_ROOT = "./test/fixtures/schema";

// Environment variable filtering for faster iteration
const fixtureFilter = Deno.env.get("FIXTURE");

// PERFORMANCE OPTIMIZATION: Batch Type-Checking
//
// Input fixture type-checking is ENABLED BY DEFAULT. Set SKIP_INPUT_CHECK=1 to disable.
//
// We batch type-check all fixtures upfront in a single TypeScript program instead of
// creating separate programs per fixture for significant performance improvement.
let batchedDiagnostics: Map<string, ts.Diagnostic[]> | undefined;

if (!Deno.env.get("SKIP_INPUT_CHECK")) {
  console.log("Batch type-checking schema fixtures...");
  const start = performance.now();

  // Load all fixture input files
  const fixtures: Record<string, string> = {};
  for await (const entry of Deno.readDir(FIXTURES_ROOT)) {
    if (entry.isFile && entry.name.endsWith(".input.ts")) {
      const fullPath = `${FIXTURES_ROOT}/${entry.name}`;
      const content = await Deno.readTextFile(fullPath);
      fixtures[fullPath] = content;
    }
  }

  batchedDiagnostics = await batchTypeCheckFixtures(fixtures);

  // Check for errors
  let hasErrors = false;
  for (const [filePath, diagnostics] of batchedDiagnostics) {
    const errors = diagnostics.filter((d) =>
      d.category === ts.DiagnosticCategory.Error
    );
    if (errors.length > 0) {
      hasErrors = true;
      console.error(`\nType errors in ${filePath}:`);
      for (const diag of errors) {
        const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
        if (diag.file && diag.start !== undefined) {
          const { line, character } = diag.file.getLineAndCharacterOfPosition(
            diag.start,
          );
          console.error(`  Line ${line + 1}, Col ${character + 1}: ${message}`);
        } else {
          console.error(`  ${message}`);
        }
      }
    }
  }

  if (hasErrors) {
    console.error("\n" + "=".repeat(60));
    console.error("INPUT VALIDATION FAILED");
    console.error(
      "Fix the type errors above, or run with SKIP_INPUT_CHECK=1 to skip.",
    );
    console.error("=".repeat(60) + "\n");
    Deno.exit(1);
  }

  console.log(
    `  -> ${Object.keys(fixtures).length} fixtures in ${
      (performance.now() - start).toFixed(0)
    }ms`,
  );
}

defineFixtureSuite<SchemaResult, string>({
  suiteName: "Schema fixtures",
  rootDir: FIXTURES_ROOT,
  expectedPath: ({ stem }) => `${stem}.expected.json`,
  skip: (fixture) => {
    if (fixtureFilter && fixture.baseName !== fixtureFilter) {
      return true;
    }
    return false;
  },
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
  const normalized = normalizeSchema(
    transformer.generateSchema(type, checker, typeNode),
  );
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
