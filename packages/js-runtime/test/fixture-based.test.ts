import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { StaticCache } from "@commontools/static";
import { resolve } from "@std/path";

import {
  createUnifiedDiff,
  defineFixtureSuite,
} from "@commontools/test-support/fixture-runner";
import { loadFixture, transformFixture } from "./test-utils.ts";

interface FixtureConfig {
  directory: string;
  describe: string;
  transformerOptions?: Record<string, unknown>;
  groups?: Array<{ pattern: RegExp; name: string }>;
  formatTestName?: (fileName: string) => string;
  skip?: string[];
}

const configs: FixtureConfig[] = [
  {
    directory: "ast-transform",
    describe: "AST Transformation",
    transformerOptions: { applySchemaTransformer: true },
    formatTestName: (name) => `transforms ${name.replace(/-/g, " ")}`,
  },
  {
    directory: "handler-schema",
    describe: "Handler Schema Transformation",
    transformerOptions: { applySchemaTransformer: true },
    formatTestName: (name) => `transforms ${name.replace(/-/g, " ")}`,
  },
  {
    directory: "jsx-expressions",
    describe: "JSX Expression Transformer",
    transformerOptions: { applySchemaTransformer: true },
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
    transformerOptions: { applySchemaTransformer: true },
    formatTestName: (name) => {
      const formatted = name.replace(/-/g, " ");
      if (name === "no-directive") {
        return "skips transformation without /// <cts-enable /> directive";
      }
      if (name === "with-opaque-ref") return "works with OpaqueRef transformer";
      return `transforms ${formatted}`;
    },
    skip: ["no-directive"],
  },
];

const staticCache = new StaticCache();
const commontools = await staticCache.getText("types/commontools.d.ts");
const FIXTURES_ROOT = "./test/fixtures";

for (const config of configs) {
  defineFixtureSuite<string, string>({
    suiteName: config.describe,
    rootDir: `${FIXTURES_ROOT}/${config.directory}`,
    expectedPath: ({ stem, extension }) => `${stem}.expected${extension}`,
    skip: config.skip
      ? (fixture) => config.skip!.includes(fixture.baseName)
      : undefined,
    groupBy: config.groups
      ? (fixture) => {
        for (const group of config.groups!) {
          if (group.pattern.test(fixture.baseName)) {
            return group.name;
          }
        }
        return undefined;
      }
      : undefined,
    formatTestName: config.formatTestName
      ? (fixture) => config.formatTestName!(fixture.baseName)
      : undefined,
    async execute(fixture) {
      return await transformFixture(
        `${config.directory}/${fixture.relativeInputPath}`,
        {
          types: { "commontools.d.ts": commontools },
          ...config.transformerOptions,
        },
      );
    },
    async loadExpected(fixture) {
      return await loadFixture(
        `${config.directory}/${fixture.relativeExpectedPath}`,
      );
    },
    compare(actual, expected, fixture) {
      const actualTrimmed = actual.trim();
      const expectedTrimmed = expected.trim();
      if (actualTrimmed === expectedTrimmed) return;

      const diff = createUnifiedDiff(expectedTrimmed, actualTrimmed);
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
    updateGolden(actual, fixture) {
      const normalized = `${actual.trim()}\n`;
      return Deno.writeTextFile(
        `${FIXTURES_ROOT}/${config.directory}/${fixture.relativeExpectedPath}`,
        normalized,
      );
    },
  });
}

// Special handling for tests that need the compiler
describe("Schema Transformer - Compiler Tests", () => {
  it("skips transformation without /// <cts-enable /> directive", async () => {
    const { getTypeScriptEnvironmentTypes, TypeScriptCompiler } = await import(
      "../mod.ts"
    );
    const types = await getTypeScriptEnvironmentTypes(new StaticCache());
    const typeLibs = { ...types, commontools };
    const compiler = new TypeScriptCompiler(typeLibs);

    const inputContent = await Deno.readTextFile(
      "test/fixtures/schema-transform/no-directive.input.ts",
    );

    const program = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: inputContent,
        },
        {
          name: "commontools.d.ts",
          contents: commontools,
        },
      ],
    };

    const compiled = compiler.compile(program, {
      runtimeModules: ["commontools"],
    });

    // Should NOT transform without the directive
    expect(compiled.js).toContain("commontools_1.toSchema)(");
    expect(compiled.js).not.toContain('"type":"object"');
    expect(compiled.js).not.toContain('"properties"');
    expect(compiled.js).not.toContain("satisfies");
  });
});
