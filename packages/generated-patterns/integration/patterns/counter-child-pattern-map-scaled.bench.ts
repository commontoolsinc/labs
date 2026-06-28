// SCALED child-pattern-map footprint bench (reactive-interpreter coalescing).
//
// NOT part of the integration suite (it is a `.bench.ts`, not a `.test.ts`, so
// the 147-scenario count is unchanged). It drives the
// `counter-child-pattern-map-scaled` fixture at N = 1, 4, 8 child rows so the
// PER-CHILD MARGINAL footprint (docs + scheduler nodes) is visible as a slope.
//
// Run BOTH arms and compare:
//
//   cd packages/generated-patterns
//   # OFF (legacy):
//   RI_FOOTPRINT_DUMP=1 LOG_LEVEL=error \
//     deno test -A --no-check integration/patterns/counter-child-pattern-map-scaled.bench.ts
//   # ON (interpreter):
//   RI_FOOTPRINT_DUMP=1 CF_EXPERIMENTAL_INTERPRETER=1 LOG_LEVEL=error \
//     deno test -A --no-check integration/patterns/counter-child-pattern-map-scaled.bench.ts
//
// Each N prints an `RI_FOOTPRINT {... "scenario":"childPatternMapScaled:N=k" ...}`
// line on stderr; the doc/node slope across k = 1,4,8 is the per-child marginal.
// The bench is correctness-checked too: every N asserts the row labels project
// correctly, so an interpreter divergence fails the bench (output equivalence).

import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

const N_VALUES = [1, 4, 8];

function buildScenario(n: number): PatternIntegrationScenario {
  const configs = Array.from({ length: n }, (_v, i) => ({
    id: `row-${i + 1}`,
    start: i,
    step: i + 1,
    labelPrefix: `Row${i + 1}`,
  }));
  return {
    name: `childPatternMapScaled:N=${n}`,
    module: new URL(
      "./counter-child-pattern-map-scaled.pattern.ts",
      import.meta.url,
    ),
    exportName: "counterChildPatternMapScaled",
    argument: { configs },
    steps: [
      {
        expect: [
          { path: "rowCount", value: n },
          {
            path: "rows.0.label",
            value: "Row1 (row-1) value 0",
          },
          {
            path: "rows.0.summary",
            value: "row-1 step 1",
          },
        ],
      },
      {
        events: [{ stream: "rows.0.increment", payload: { cycles: 2 } }],
        expect: [
          { path: "rows.0.value", value: 2 },
          { path: "rows.0.label", value: "Row1 (row-1) value 2" },
        ],
      },
    ],
  };
}

describe("child-pattern-map scaled footprint bench", () => {
  for (const n of N_VALUES) {
    it(`materializes ${n} interactive child rows`, async () => {
      await runPatternScenario(buildScenario(n));
    });
  }
});
