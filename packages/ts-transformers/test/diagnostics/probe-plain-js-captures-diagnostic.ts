/**
 * Q2 probe (plain-JS captures investigation): does the debug-only
 * `pattern-context:non-hoistable-callback` diagnostic fire on the four
 * fixtures the post-pipeline probe identified, and if so what does it
 * say?
 *
 * Background: PR #3550's `module-scope-callback-hoisting.ts` added a
 * debug-gated diagnostic that fires when a builder callback captures
 * enclosing-scope bindings and therefore cannot be hoisted to module
 * scope. PR #3550's writeup flagged the diagnostic as noisy (~160
 * firings, mostly false positives from synthesized destructured
 * bindings), which is why it's gated behind `options.debug`. This
 * probe asks: does it correctly identify the four real plain-JS
 * captures we know about, or are they lost in the noise?
 *
 * Population (from probe-derive-callback-captures.ts):
 *   - closures/map-multiple-captures.input.tsx          captures: multiplier
 *   - closures/filter-flatmap-plain-captures.input.tsx  captures: suffix, prefix
 *   - closures/map-plain-array-no-transform.input.tsx   captures: n
 *
 * Usage (from packages/ts-transformers):
 *   deno run -A test/diagnostics/probe-plain-js-captures-diagnostic.ts
 *
 * Output:
 *   For each of the 4 fixtures: total non-hoistable diagnostic firings,
 *   and whether any of them mention the expected capture names.
 *
 * Diagnostic; not a test. Safe to delete once Q2 is closed.
 */
import type { TransformationDiagnostic } from "../../src/mod.ts";
import { loadFixture, transformSource } from "../utils.ts";

interface FixtureSpec {
  relativePath: string;
  expectedCaptures: string[];
}

const POPULATION: readonly FixtureSpec[] = [
  {
    relativePath: "closures/map-multiple-captures.input.tsx",
    expectedCaptures: ["multiplier"],
  },
  {
    relativePath: "closures/filter-flatmap-plain-captures.input.tsx",
    expectedCaptures: ["suffix", "prefix"],
  },
  {
    relativePath: "closures/map-plain-array-no-transform.input.tsx",
    expectedCaptures: ["n"],
  },
];

interface RunResult {
  fixture: string;
  totalDiagnostics: number;
  nonHoistableDiagnostics: number;
  matchedCaptures: string[];
  unmatchedExpectedCaptures: string[];
  sampleMessages: string[];
}

async function runFixture(spec: FixtureSpec): Promise<RunResult> {
  // loadFixture accepts a path relative to test/fixtures
  const source = await loadFixture(spec.relativePath);
  const pipelineDiagnostics: TransformationDiagnostic[] = [];
  try {
    await transformSource(source, {
      mode: "transform",
      debug: true,
      pipelineDiagnostics,
    });
  } catch (e) {
    return {
      fixture: spec.relativePath,
      totalDiagnostics: pipelineDiagnostics.length,
      nonHoistableDiagnostics: 0,
      matchedCaptures: [],
      unmatchedExpectedCaptures: spec.expectedCaptures,
      sampleMessages: [`(transform threw: ${String(e).slice(0, 120)})`],
    };
  }

  const nonHoistable = pipelineDiagnostics.filter(
    (d) => d.type === "pattern-context:non-hoistable-callback",
  );
  // Spot any other types we're missing
  const otherTypes = new Set(
    pipelineDiagnostics
      .map((d) => d.type)
      .filter((t) => t !== "pattern-context:non-hoistable-callback"),
  );
  if (otherTypes.size > 0) {
    console.error(
      `  other diagnostic types in this fixture: [${
        Array.from(otherTypes).join(", ")
      }]`,
    );
  }

  const matchedCaptures: string[] = [];
  const unmatchedExpectedCaptures: string[] = [];
  for (const expected of spec.expectedCaptures) {
    const found = nonHoistable.some((d) => d.message.includes(expected));
    if (found) matchedCaptures.push(expected);
    else unmatchedExpectedCaptures.push(expected);
  }

  const sampleMessages = nonHoistable.slice(0, 3).map((d) =>
    d.message.slice(0, 160)
  );

  return {
    fixture: spec.relativePath,
    totalDiagnostics: pipelineDiagnostics.length,
    nonHoistableDiagnostics: nonHoistable.length,
    matchedCaptures,
    unmatchedExpectedCaptures,
    sampleMessages,
  };
}

async function main(): Promise<void> {
  const rows: RunResult[] = [];
  for (const spec of POPULATION) {
    rows.push(await runFixture(spec));
  }

  console.log("fixture\ttotalDiags\tnonHoistableDiags\tmatched\tunmatched");
  for (const r of rows) {
    console.log(
      [
        r.fixture,
        r.totalDiagnostics,
        r.nonHoistableDiagnostics,
        r.matchedCaptures.join(","),
        r.unmatchedExpectedCaptures.join(","),
      ].join("\t"),
    );
  }

  console.error("\n=== detail ===\n");
  for (const r of rows) {
    console.error(`# ${r.fixture}`);
    console.error(
      `  non-hoistable diags: ${r.nonHoistableDiagnostics} / total ${r.totalDiagnostics}`,
    );
    console.error(`  matched expected: [${r.matchedCaptures.join(", ")}]`);
    console.error(
      `  unmatched expected: [${r.unmatchedExpectedCaptures.join(", ")}]`,
    );
    if (r.sampleMessages.length > 0) {
      console.error(`  sample messages:`);
      for (const m of r.sampleMessages) console.error(`    - ${m}`);
    }
    console.error("");
  }
}

if (import.meta.main) {
  await main();
}
