import { assert, assertEquals, assertThrows } from "@std/assert";
import { expect } from "@std/expect";
import { ensureDir } from "@std/fs/ensure-dir";
import { dirname, resolve } from "@std/path";
import ts from "typescript";

import {
  createUnifiedDiff,
  defineFixtureSuite,
} from "@commonfabric/test-support/fixture-runner";
import {
  JsonEncodingContext,
  jsonFromValue,
  valueFromJson,
} from "@commonfabric/data-model/codec-json";
import {
  type FabricValue,
  valueEqual,
} from "@commonfabric/data-model/fabric-value";
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
    let expectedValue;
    try {
      expectedValue = decodeGolden(expectedText);
    } catch (error) {
      throw new Error(
        `Golden decoding failed for ${fixture.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // A generated schema is a fabric value; `normalizeArrayOrdering` is typed
    // loosely because it walks arbitrary structure.
    const normalizedActual = normalizeArrayOrdering(
      actual.normalized,
    ) as FabricValue;
    const normalizedExpected = normalizeArrayOrdering(
      expectedValue,
    ) as FabricValue;

    // `valueEqual` is the value model's own equality: `Object.is` at primitive
    // leaves, so -0 does not pass as 0 and NaN equals itself, and it knows the
    // whole `FabricValue` vocabulary the decoded golden can contain.
    if (!valueEqual(normalizedActual, normalizedExpected)) {
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
  return { normalized, serialized: encodeGolden(normalized) };
}

/**
 * Render a value as golden-file text: its fabric JSON encoding, pretty-printed.
 *
 * `JSON.stringify()` cannot represent every `FabricValue`, and the schema
 * generator is free to produce ones it cannot. Worse, it mostly does not refuse
 * them: it substitutes quietly, rendering `-0` as `0` and `NaN` and the
 * infinities as `null`. (A bigint is the exception that throws outright.) A
 * golden that cannot hold a value cannot guard it, and a golden that silently
 * flattens one agrees with buggy output instead of catching it. The fabric
 * encoding has a representation for every `FabricValue`, so the golden holds
 * whatever the generator produced.
 *
 * The encoding's prefix tag identifies it on the wire but is not part of the
 * JSON, so it cannot survive pretty-printing. Taking it off and putting it back
 * goes through `JsonEncodingContext`'s test-only helpers, which is what keeps
 * the tag defined in exactly one place. Key order needs no help: a conforming
 * encoder emits plain-object keys in canonical order.
 */
function encodeGolden(value: unknown): string {
  const body = JSON.parse(
    JsonEncodingContext.unwrapEncodedValueForTesting(
      jsonFromValue(value as FabricValue),
    ),
  );
  return JSON.stringify(body, null, 2) + "\n";
}

/** Inverse of {@link encodeGolden}. */
function decodeGolden(text: string): unknown {
  return valueFromJson(
    JsonEncodingContext.wrapEncodedValueForTesting(text.trim()),
  );
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

// The golden format exists to hold values plain JSON cannot. Guard that
// directly: a fixture cannot reach these values on its own yet, and a golden
// that silently flattens them would agree with buggy output instead of
// catching it.
Deno.test("golden encoding preserves values JSON cannot represent", () => {
  const schema = {
    type: "object",
    properties: {
      negZero: { type: "number", default: -0 },
      nan: { type: "number", default: NaN },
      inf: { type: "number", default: Infinity },
      negInf: { type: "number", default: -Infinity },
      big: { type: "integer", default: 12345678901234567890n },
      ordinary: { type: "number", default: -1 },
    },
  };

  const decoded = decodeGolden(encodeGolden(schema)) as {
    properties: Record<string, { default: unknown }>;
  };
  const back = decoded.properties;

  // Asserted leaf by leaf with `Object.is`: a structural compare would let -0
  // through as 0, which is one of the conflations under test.
  assert(Object.is(back.negZero!.default, -0), "-0 lost its sign");
  assert(Object.is(back.nan!.default, NaN), "NaN did not survive");
  assertEquals(back.inf!.default, Infinity);
  assertEquals(back.negInf!.default, -Infinity);
  assertEquals(back.big!.default, 12345678901234567890n);
  assertEquals(back.ordinary!.default, -1);

  assert(valueEqual(schema as FabricValue, decoded as FabricValue));
});

Deno.test("plain JSON would lose exactly those values", () => {
  // Not a test of our code -- an executable statement of why the golden format
  // is what it is. If these ever stop holding, the encoding indirection can go.
  const roundTrip = (v: unknown) => JSON.parse(JSON.stringify({ v })).v;

  assert(Object.is(roundTrip(-0), 0), "JSON kept the sign of -0");
  assertEquals(roundTrip(NaN), null);
  assertEquals(roundTrip(Infinity), null);
  assertEquals(roundTrip(-Infinity), null);
  assertThrows(() => JSON.stringify({ v: 1n }), TypeError);
});
