// SCALED intermediate-chain child bench (reactive-interpreter coalescing).
//
// Companion to counter-child-pattern-map-scaled.bench.ts. Drives the
// `counter-child-intermediate-chain-scaled` fixture at N = 1, 4, 8 to isolate
// whether interpreting a launched child COALESCES its PURELY-INTERMEDIATE
// scalar-lift docs (a deep a→b→c→d chain feeding ONLY the final `display`).
//
//   cd packages/generated-patterns
//   RI_FOOTPRINT_DUMP=1 LOG_LEVEL=error \
//     deno test -A --no-check integration/patterns/counter-child-intermediate-chain-scaled.bench.ts
//   RI_FOOTPRINT_DUMP=1 CF_EXPERIMENTAL_INTERPRETER=1 LOG_LEVEL=error \
//     deno test -A --no-check integration/patterns/counter-child-intermediate-chain-scaled.bench.ts

import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

const N_VALUES = [1, 4, 8];

function buildScenario(n: number): PatternIntegrationScenario {
  const configs = Array.from({ length: n }, (_v, i) => ({
    id: `row-${i + 1}`,
    start: i,
  }));
  return {
    name: `childIntermediateChainScaled:N=${n}`,
    module: new URL(
      "./counter-child-intermediate-chain-scaled.pattern.ts",
      import.meta.url,
    ),
    exportName: "counterChildIntermediateChainScaled",
    argument: { configs },
    steps: [
      {
        // value=0 → a=1 → b=2 → c=-1 → d=1; display = "row-1: 1"
        expect: [
          { path: "rowCount", value: n },
          { path: "rows.0.display", value: "row-1: 1" },
        ],
      },
      {
        events: [{ stream: "rows.0.increment", payload: { cycles: 5 } }],
        expect: [
          { path: "rows.0.value", value: 5 },
          // value=5 → a=6 → b=12 → c=9 → d=9; display = "row-1: 9"
          { path: "rows.0.display", value: "row-1: 9" },
        ],
      },
    ],
  };
}

describe("intermediate-chain child scaled footprint bench", () => {
  for (const n of N_VALUES) {
    it(`materializes ${n} intermediate-chain child rows`, async () => {
      await runPatternScenario(buildScenario(n));
    });
  }
});
