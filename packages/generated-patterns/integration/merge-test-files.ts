#!/usr/bin/env -S deno run --allow-read --allow-write

/**
 * Script to merge pattern scenario files into their test files
 *
 * Combines:
 *   patterns/simple-counter.ts + patterns/simple-counter.test.ts
 *   -> patterns/simple-counter.test.ts (with scenarios inline)
 *
 * Then deletes the original .ts files
 */

import { join } from "@std/path";

interface MergeResult {
  pattern: string;
  success: boolean;
  error?: string;
}

async function mergeFiles(
  scenarioFile: string,
  testFile: string,
): Promise<MergeResult> {
  const baseName = scenarioFile.split("/").pop()!.replace(/\.ts$/, "");

  try {
    // Read both files
    const scenarioContent = await Deno.readTextFile(scenarioFile);
    const testContent = await Deno.readTextFile(testFile);

    // Extract everything except the first import line from the scenario file
    // (remove the PatternIntegrationScenario import since it will be in the merged file)
    const scenarioLines = scenarioContent.split("\n");

    // Find all imports in the scenario file
    const imports: string[] = [];
    const nonImportLines: string[] = [];
    let inImport = false;

    for (const line of scenarioLines) {
      if (line.startsWith("import ") || inImport) {
        if (line.includes("PatternIntegrationScenario")) {
          // Skip this import, we'll add it from the test file
          if (!line.trim().endsWith(";") && !line.includes("}")) {
            inImport = true;
          } else {
            inImport = false;
          }
        } else {
          imports.push(line);
          if (!line.trim().endsWith(";") && !line.includes("}")) {
            inImport = true;
          } else {
            inImport = false;
          }
        }
      } else if (!inImport) {
        nonImportLines.push(line);
      }
    }

    // Build the merged content
    const mergedContent = `import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";
${imports.filter((i) => i.trim()).join("\n")}

${nonImportLines.join("\n").trim()}

describe("${baseName}", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
`;

    // Write the merged content to the test file
    await Deno.writeTextFile(testFile, mergedContent);

    // Delete the original scenario file
    await Deno.remove(scenarioFile);

    return {
      pattern: baseName,
      success: true,
    };
  } catch (error) {
    return {
      pattern: baseName,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const patternsDir = join(
    new URL(import.meta.url).pathname.replace(/\/[^/]+$/, ""),
    "patterns",
  );

  console.log(`Processing patterns in: ${patternsDir}\n`);

  const results: MergeResult[] = [];

  // Find all .ts files (not .pattern.ts or .test.ts)
  for await (const entry of Deno.readDir(patternsDir)) {
    if (
      entry.isFile &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".pattern.ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".md")
    ) {
      const scenarioFile = join(patternsDir, entry.name);
      const testFile = join(
        patternsDir,
        entry.name.replace(/\.ts$/, ".test.ts"),
      );

      // Check if test file exists
      try {
        await Deno.stat(testFile);
        const result = await mergeFiles(scenarioFile, testFile);
        results.push(result);

        if (result.success) {
          console.log(
            `✓ ${entry.name} merged into ${
              entry.name.replace(/\.ts$/, ".test.ts")
            }`,
          );
        } else {
          console.log(`✗ ${entry.name}: ${result.error}`);
        }
      } catch {
        console.log(`⚠ ${entry.name}: test file not found, skipping`);
      }
    }
  }

  // Summary
  console.log(`\n--- Summary ---`);
  console.log(`Total files: ${results.length}`);
  console.log(`Successful: ${results.filter((r) => r.success).length}`);
  console.log(`Failed: ${results.filter((r) => !r.success).length}`);

  if (results.some((r) => !r.success)) {
    console.log("\nFailed merges:");
    results.filter((r) => !r.success).forEach((r) => {
      console.log(`  - ${r.pattern}: ${r.error}`);
    });
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
