import {
  collectCoverageDebtMetricsFromLcov,
  collectSourceFiles,
  countUncoveredProfileLines,
  parseLcov,
} from "./coverage-metrics.ts";

const covDir = Deno.args[0];
const rootDir = Deno.args[1];

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* walk(full);
    else yield full;
  }
}
let combined = "";
const chunks: string[] = [];
for await (const file of walk(covDir)) {
  if (!file.endsWith(".lcov")) continue;
  let text = await Deno.readTextFile(file);
  text = text.replaceAll("/home/runner/work/labs/labs/", rootDir + "/");
  chunks.push(text);
}
combined = chunks.join("\n");

const metrics = await collectCoverageDebtMetricsFromLcov({
  rootDir,
  lcov: combined,
});
for (const m of metrics) {
  if (m.name.includes("runner") || m.name.includes("workspace")) {
    console.log(m.name, "=", m.uncoveredLines);
  }
}

// Per-file inventory for my touched files.
const MY = [
  "packages/runner/src/cfc/label-introspection.ts",
  "packages/runner/src/builtins/inspect-conf-label.ts",
  "packages/runner/src/cfc/prepare.ts",
  "packages/runner/src/cfc/canonical.ts",
  "packages/runner/src/cfc/types.ts",
  "packages/runner/src/cfc/mod.ts",
  "packages/runner/src/cfc/label-view-core.ts",
  "packages/runner/src/cfc/observation-classes.ts",
  "packages/runner/src/storage/extended-storage-transaction.ts",
  "packages/runner/src/storage/interface.ts",
  "packages/runner/src/builder/built-in.ts",
  "packages/runner/src/builder/factory.ts",
  "packages/runner/src/builder/types.ts",
  "packages/runner/src/builtins/index.ts",
];
const sources = await collectSourceFiles(rootDir);
const lcovCoverage = parseLcov(combined);
for (const source of sources) {
  if (!MY.includes(source.relativePath)) continue;
  const coverage = lcovCoverage.get(source.absolutePath);
  const uncovered = coverage
    ? countUncoveredProfileLines(coverage)
    : source.trackedLineCount;
  console.log(
    source.relativePath,
    "->",
    uncovered,
    coverage ? "(has record)" : "(NEVER LOADED — full tracked count)",
  );
}
