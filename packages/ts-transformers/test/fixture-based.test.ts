import {
  createUnifiedDiff,
  defineFixtureSuite,
} from "@commontools/test-support/fixture-runner";
import { StaticCache } from "@commontools/static";
import { resolve } from "@std/path";

import { loadFixture, transformFixture } from "./utils.ts";

interface FixtureConfig {
  directory: string;
  describe: string;
  transformerOptions?: Record<string, unknown>;
  groups?: Array<{ pattern: RegExp; name: string }>;
  formatTestName?: (fileName: string) => string;
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
    transformerOptions: {
      applySchemaTransformer: true,
    },
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
      if (name === "with-opaque-ref") return "works with OpaqueRef transformer";
      return `transforms ${formatted}`;
    },
    groups: [
      { pattern: /with-opaque-ref/, name: "OpaqueRef integration" },
    ],
  },
];

const staticCache = new StaticCache();
const commontools = await staticCache.getText("types/commontools.d.ts");
const FIXTURES_ROOT = "./test/fixtures";

for (const config of configs) {
  const suiteConfig = {
    suiteName: config.describe,
    rootDir: `${FIXTURES_ROOT}/${config.directory}`,
    expectedPath: ({ stem, extension }: { stem: string; extension: string }) =>
      `${stem}.expected${extension}`,
    async execute(fixture: { relativeInputPath: string }) {
      return await transformFixture(
        `${config.directory}/${fixture.relativeInputPath}`,
        {
          types: { "commontools.d.ts": commontools },
          ...config.transformerOptions,
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
