/**
 * Example usage of the transaction rollup functions
 *
 * This demonstrates how to use the rollup functions with different options
 * to produce concise summaries suitable for LLM consumption.
 */

import {
  createTransactionRollup,
  loadTransactionDetails,
  type RollupOptions,
} from "./tx-rollup.ts";

// Example 1: Minimal rollup - just the essentials
async function minimalRollup() {
  console.log("=== Minimal Rollup ===\n");

  const { journal, result } = await loadTransactionDetails(
    "./tx-details/journal.json",
    "./tx-details/result.json"
  );

  const rollup = createTransactionRollup(journal, result, {
    includeReads: false, // Skip read operations
    includeComplexValues: false, // Skip complex nested objects
    maxValueLength: 50, // Truncate long strings
  });

  console.log("Summary:", rollup.summary);
  console.log("\nChanged fields:");
  for (const change of rollup.changes) {
    console.log(`  Object: ${change.objectIdShort}`);
    for (const field of change.changedFields) {
      console.log(`    ${field.path} = ${JSON.stringify(field.newValue)}`);
    }
  }
  console.log();
}

// Example 2: Detailed rollup - include reads and link resolutions
async function detailedRollup() {
  console.log("=== Detailed Rollup ===\n");

  const { journal, result } = await loadTransactionDetails(
    "./tx-details/journal.json",
    "./tx-details/result.json"
  );

  const rollup = createTransactionRollup(journal, result, {
    includeReads: true, // Include read operations
    includeComplexValues: false,
    maxValueLength: 100,
    includeLinkResolutions: true, // Include link resolutions
  });

  console.log("Summary:", rollup.summary);
  console.log("\nUser-facing charm:", rollup.userFacingCharm);
  console.log("\nActivity breakdown:");
  console.log(`  Total operations: ${rollup.activity.totalOperations}`);
  console.log(`  Reads: ${rollup.activity.reads}`);
  console.log(`  Writes: ${rollup.activity.writes}`);

  if (rollup.activity.uniquePathsRead && rollup.activity.uniquePathsRead.length > 0) {
    console.log(`\nUnique paths read (${rollup.activity.uniquePathsRead.length}):`);
    for (const path of rollup.activity.uniquePathsRead.slice(0, 5)) {
      console.log(`  - ${path}`);
    }
    if (rollup.activity.uniquePathsRead.length > 5) {
      console.log(`  ... and ${rollup.activity.uniquePathsRead.length - 5} more`);
    }
  }

  if (rollup.linkResolutions && rollup.linkResolutions.length > 0) {
    console.log(`\nLink resolutions (${rollup.linkResolutions.length}):`);
    for (const link of rollup.linkResolutions.slice(0, 3)) {
      console.log(`  ${link.from} -> ${link.to} (via ${link.path.join(".")})`);
    }
  }
  console.log();
}

// Example 3: LLM-optimized format
async function llmOptimizedRollup() {
  console.log("=== LLM-Optimized Format ===\n");

  const { journal, result } = await loadTransactionDetails(
    "./tx-details/journal.json",
    "./tx-details/result.json"
  );

  const rollup = createTransactionRollup(journal, result, {
    includeReads: false,
    includeComplexValues: false,
    maxValueLength: 100,
  });

  // Format for LLM consumption
  const llmPrompt = `
Transaction Debug Information:

${rollup.summary}

Details:
- Command: ${rollup.command}
- Handler invoked: ${rollup.includesHandlerCall ? "Yes" : "No"}
- Objects modified: ${rollup.objectsChanged}
- User-facing charm: ${rollup.userFacingCharm || "N/A"}

Field Changes:
${rollup.changes.flatMap(c =>
  c.changedFields.map(f =>
    `- ${f.path}: ${JSON.stringify(f.newValue)}`
  )
).join("\n")}

Activity:
- ${rollup.activity.writes} write operation(s)
- ${rollup.activity.reads} read operation(s)

What happened:
This transaction shows that a handler was called which updated the content field
of a note from its previous value to "12345". The user was editing a note titled
"${rollup.changes[0]?.changedFields.find(f => f.path === "argument.title")?.newValue}".
`.trim();

  console.log(llmPrompt);
  console.log();
}

// Example 4: JSON export for programmatic use
async function jsonExport() {
  console.log("=== JSON Export ===\n");

  const { journal, result } = await loadTransactionDetails(
    "./tx-details/journal.json",
    "./tx-details/result.json"
  );

  const rollup = createTransactionRollup(journal, result);

  // Export as JSON for further processing
  const jsonOutput = JSON.stringify(rollup, null, 2);
  console.log(jsonOutput);
}

// Run examples based on command line argument
if (import.meta.main) {
  const example = Deno.args[0] || "minimal";

  try {
    switch (example) {
      case "minimal":
        await minimalRollup();
        break;
      case "detailed":
        await detailedRollup();
        break;
      case "llm":
        await llmOptimizedRollup();
        break;
      case "json":
        await jsonExport();
        break;
      case "all":
        await minimalRollup();
        await detailedRollup();
        await llmOptimizedRollup();
        break;
      default:
        console.log("Unknown example:", example);
        console.log("Available examples: minimal, detailed, llm, json, all");
        Deno.exit(1);
    }
  } catch (error) {
    console.error("Error:", error.message);
    Deno.exit(1);
  }
}
