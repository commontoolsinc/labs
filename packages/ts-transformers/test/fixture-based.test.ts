import {
  createUnifiedDiff,
  defineFixtureSuite,
} from "@commontools/test-support/fixture-runner";
import { StaticCacheFS } from "@commontools/static";
import { resolve } from "@std/path";
import ts from "typescript";

import {
  batchTypeCheckFixtures,
  loadFixture,
  transformFixture,
} from "./utils.ts";

interface FixtureConfig {
  directory: string;
  describe: string;
  groups?: Array<{ pattern: RegExp; name: string }>;
  formatTestName?: (fileName: string) => string;
}

const configs: FixtureConfig[] = [
  {
    directory: "ast-transform",
    describe: "AST Transformation",
    formatTestName: (name) => `transforms ${name.replace(/-/g, " ")}`,
  },
  {
    directory: "handler-schema",
    describe: "Handler Schema Transformation",
    formatTestName: (name) => `transforms ${name.replace(/-/g, " ")}`,
  },
  {
    directory: "jsx-expressions",
    describe: "JSX Expression Transformer",
    formatTestName: (name) => {
      const formatted = name.replace(/-/g, " ");
      if (name.includes("no-transform")) {
        return `does not transform ${formatted.replace("no transform ", "")}`;
      }
      return `transforms ${formatted}`;
    },
  },
  {
    directory: "schema-transform",
    describe: "Schema Transformer",
    formatTestName: (name) => {
      const formatted = name.replace(/-/g, " ");
      if (name === "with-opaque-ref") return "works with OpaqueRef transformer";
      return `transforms ${formatted}`;
    },
    groups: [
      { pattern: /with-opaque-ref/, name: "OpaqueRef integration" },
    ],
  },
  {
    directory: "closures",
    describe: "Closure Transformation",
    formatTestName: (name) => `transforms ${name.replace(/-/g, " ")}`,
    groups: [
      { pattern: /^map-/, name: "Map callbacks" },
      { pattern: /^event-/, name: "Event handlers" },
      { pattern: /^lift-/, name: "Generic closures" },
    ],
  },
  {
    directory: "schema-injection",
    describe: "Schema Injection with Literal Widening",
    formatTestName: (name) => {
      if (name.startsWith("literal-widen-")) {
        return `widens ${
          name.replace(/^literal-widen-/, "").replace(/-/g, " ")
        }`;
      }
      if (name.startsWith("double-inject-")) {
        return `prevents ${
          name.replace(/^double-inject-/, "").replace(/-/g, " ")
        }`;
      }
      if (name.startsWith("context-")) {
        return name.replace(/-/g, " ");
      }
      if (name.startsWith("cell-like-")) {
        return name.replace(/-/g, " ");
      }
      if (name.startsWith("collections-")) {
        return `handles ${
          name.replace(/^collections-/, "").replace(/-/g, " ")
        }`;
      }
      return name.replace(/-/g, " ");
    },
  },
];

const staticCache = new StaticCacheFS();
const commontools = await staticCache.getText("types/commontools.d.ts");
const commontoolsSchema = await staticCache.getText(
  "types/commontools-schema.d.ts",
);
const FIXTURES_ROOT = "./test/fixtures";

// Environment variable filtering for faster iteration
// Usage: FIXTURE=map-array-destructured deno task test
// Or: FIXTURE_PATTERN="array.*destructured" deno task test
const fixtureFilter = Deno.env.get("FIXTURE");
const fixturePattern = Deno.env.get("FIXTURE_PATTERN");

/**
 * Loads all fixture input files from a directory for batch type-checking
 */
async function loadAllFixturesInDirectory(
  directory: string,
): Promise<Record<string, string>> {
  const fixtures: Record<string, string> = {};

  // Find all .input.* files in the directory
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isFile && entry.name.includes(".input.")) {
      const fullPath = `${directory}/${entry.name}`;
      const content = await Deno.readTextFile(fullPath);
      // Normalize path: remove leading ./ if present
      const normalizedPath = fullPath.startsWith("./")
        ? fullPath.slice(2)
        : fullPath;
      fixtures[normalizedPath] = content;
    }
  }

  return fixtures;
}

// PERFORMANCE OPTIMIZATION: Batch Type-Checking
//
// Input fixture type-checking is ENABLED BY DEFAULT. Set SKIP_INPUT_CHECK=1 to disable.
//
// We batch type-check all fixtures upfront in a single TypeScript program instead of
// creating separate programs per fixture. This provides a significant performance improvement:
//
// - WITHOUT batching: ~16s (166 programs × 100ms each)
// - WITH batching: ~4s (1 program × 600ms + 166 transforms × 20ms)
// - Speedup: 4-6x faster
//
// The batching works by:
// 1. Loading all fixture files upfront
// 2. Creating one ts.Program with all fixtures as separate files
// 3. Running ts.getPreEmitDiagnostics() once for all files
// 4. Storing diagnostics in a Map keyed by file path
// 5. Individual tests retrieve their precomputed diagnostics from the Map
//
// To skip input validation temporarily, run with SKIP_INPUT_CHECK=1.
const batchedDiagnosticsByConfig = new Map<
  string,
  Map<string, ts.Diagnostic[]>
>();

if (!Deno.env.get("SKIP_INPUT_CHECK")) {
  const batchStart = performance.now();
  for (const config of configs) {
    const configStart = performance.now();

    let allFixtures = await loadAllFixturesInDirectory(
      `${FIXTURES_ROOT}/${config.directory}`,
    );

    // Apply FIXTURE/FIXTURE_PATTERN filter to batch type-checking for faster iteration
    if (fixtureFilter || fixturePattern) {
      const filteredFixtures: Record<string, string> = {};
      for (const [path, content] of Object.entries(allFixtures)) {
        // Extract base name from path (e.g., "test/fixtures/closures/map-basic.input.tsx" -> "map-basic")
        const fileName = path.split("/").pop() || "";
        const baseName = fileName.replace(/\.input\.(tsx?|ts)$/, "");

        const matchesFilter = fixtureFilter
          ? baseName === fixtureFilter
          : new RegExp(fixturePattern!).test(baseName);

        if (matchesFilter) {
          filteredFixtures[path] = content;
        }
      }
      allFixtures = filteredFixtures;
    }

    // Skip empty fixture sets (when filter doesn't match any in this directory)
    if (Object.keys(allFixtures).length === 0) {
      continue;
    }

    console.log(`Batch type-checking fixtures in ${config.describe}...`);

    const result = await batchTypeCheckFixtures(allFixtures, {
      types: {
        "commontools.d.ts": commontools,
        "commontools-schema.d.ts": commontoolsSchema,
      },
    });

    console.log(
      `  -> ${Object.keys(allFixtures).length} fixtures in ${
        (performance.now() - configStart).toFixed(0)
      }ms`,
    );

    batchedDiagnosticsByConfig.set(config.describe, result.diagnosticsByFile);
  }
  console.log(
    `Total batch type-checking time: ${
      (performance.now() - batchStart).toFixed(0)
    }ms`,
  );
}

// Now run the tests
for (const config of configs) {
  const suiteConfig = {
    suiteName: config.describe,
    rootDir: `${FIXTURES_ROOT}/${config.directory}`,
    expectedPath: ({ stem, extension }: { stem: string; extension: string }) =>
      `${stem}.expected${extension}`,
    skip: (fixture: { baseName: string }) => {
      if (fixtureFilter && fixture.baseName !== fixtureFilter) {
        return true;
      }
      if (
        fixturePattern && !new RegExp(fixturePattern).test(fixture.baseName)
      ) {
        return true;
      }
      return false;
    },
    async execute(fixture: { relativeInputPath: string }) {
      // Construct full path matching the keys in batchedDiagnostics (remove leading ./)
      const fullPath =
        `${FIXTURES_ROOT}/${config.directory}/${fixture.relativeInputPath}`
          .replace(/^\.\//, "");

      // Get precomputed diagnostics if available
      const diagnosticsMap = batchedDiagnosticsByConfig.get(config.describe);
      const precomputedDiagnostics = diagnosticsMap?.get(fullPath);

      return await transformFixture(
        `${config.directory}/${fixture.relativeInputPath}`,
        {
          types: {
            "commontools.d.ts": commontools,
            "commontools-schema.d.ts": commontoolsSchema,
          },
          typeCheck: !Deno.env.get("SKIP_INPUT_CHECK"),
          precomputedDiagnostics,
        },
      );
    },
    async loadExpected(fixture: { relativeExpectedPath: string }) {
      return await loadFixture(
        `${config.directory}/${fixture.relativeExpectedPath}`,
      );
    },
    compare(actual: string, expected: string, fixture: {
      baseName: string;
      relativeInputPath: string;
      relativeExpectedPath: string;
    }) {
      if (actual === expected) return;
      const diff = createUnifiedDiff(expected, actual);
      let message =
        `\n\nTransformation output does not match expected for: ${fixture.baseName}\n`;
      message += `\nFiles:\n`;
      message += `  Input:    ${
        resolve(
          `${FIXTURES_ROOT}/${config.directory}/${fixture.relativeInputPath}`,
        )
      }\n`;
      message += `  Expected: ${
        resolve(
          `${FIXTURES_ROOT}/${config.directory}/${fixture.relativeExpectedPath}`,
        )
      }\n`;
      message += `\n${"=".repeat(80)}\n`;
      message += `UNIFIED DIFF (expected vs actual):\n`;
      message += `${"=".repeat(80)}\n`;
      message += diff;
      message += `\n${"=".repeat(80)}\n`;
      throw new Error(message);
    },
    updateGolden(actual: string, fixture: { relativeExpectedPath: string }) {
      const normalized = `${actual}\n`;
      return Deno.writeTextFile(
        `${FIXTURES_ROOT}/${config.directory}/${fixture.relativeExpectedPath}`,
        normalized,
      );
    },
  };

  if (config.formatTestName) {
    Object.assign(suiteConfig, {
      formatTestName: (fixture: { baseName: string }) =>
        config.formatTestName!(fixture.baseName),
    });
  }

  if (config.groups) {
    Object.assign(suiteConfig, {
      groupBy: (fixture: { baseName: string }) => {
        for (const group of config.groups!) {
          if (group.pattern.test(fixture.baseName)) {
            return group.name;
          }
        }
        return undefined;
      },
    });
  }

  defineFixtureSuite<string, string>(suiteConfig);
}
