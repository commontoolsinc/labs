#!/usr/bin/env -S deno run --allow-read --allow-write

/**
 * Script to convert pattern test files to standalone test files
 *
 * Converts files like:
 *   patterns/simple-counter.ts -> patterns/simple-counter.test.ts
 *
 * The new test files will:
 * 1. Import runPatternScenario from ../pattern-harness.ts
 * 2. Import their own scenarios
 * 3. Create individual test cases for each scenario
 */

import { dirname, join } from "@std/path";

interface ConversionResult {
  source: string;
  target: string;
  success: boolean;
  error?: string;
}

async function convertFile(filePath: string): Promise<ConversionResult> {
  const source = filePath;
  const target = filePath.replace(/\.ts$/, ".test.ts");

  try {
    // Read the original file to verify it has a scenarios export
    const content = await Deno.readTextFile(filePath);

    // Check for scenarios export (e.g., "export const scenarios = ...")
    if (!content.includes("export const scenarios")) {
      return {
        source,
        target,
        success: false,
        error: "No scenarios export found",
      };
    }

    // Get the base name for the import
    const baseName = filePath.split("/").pop()!.replace(/\.ts$/, "");

    // Generate the new test file content
    const testContent = `import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import { scenarios } from "./${baseName}.ts";

describe("${baseName}", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
`;

    // Write the new test file
    await Deno.writeTextFile(target, testContent);

    return {
      source,
      target,
      success: true,
    };
  } catch (error) {
    return {
      source,
      target,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const patternsDir = join(
    dirname(new URL(import.meta.url).pathname),
    "patterns",
  );

  console.log(`Processing patterns in: ${patternsDir}\n`);

  const results: ConversionResult[] = [];

  // Find all .ts files (but not .pattern.ts or .test.ts files)
  for await (const entry of Deno.readDir(patternsDir)) {
    if (
      entry.isFile &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".pattern.ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".md")
    ) {
      const filePath = join(patternsDir, entry.name);
      const result = await convertFile(filePath);
      results.push(result);

      if (result.success) {
        console.log(
          `✓ ${entry.name} -> ${entry.name.replace(/\.ts$/, ".test.ts")}`,
        );
      } else {
        console.log(`✗ ${entry.name}: ${result.error}`);
      }
    }
  }

  // Summary
  console.log(`\n--- Summary ---`);
  console.log(`Total files: ${results.length}`);
  console.log(`Successful: ${results.filter((r) => r.success).length}`);
  console.log(`Failed: ${results.filter((r) => !r.success).length}`);

  if (results.some((r) => !r.success)) {
    console.log("\nFailed conversions:");
    results.filter((r) => !r.success).forEach((r) => {
      console.log(`  - ${r.source}: ${r.error}`);
    });
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
