import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

// Verifies the "lift() in a handler-created piece resolves only at 1 hop"
// hypothesis. A handler spawns a Viewer piece that (a) builds a lift from the
// passed-in `items` cell in its OWN body (1 hop) and (b) delegates `items` to
// a nested Child pattern that builds the same lift (2 hops). We seed `items`,
// fire the spawn handler, and assert on BOTH lift results.
//
// If the hypothesis holds, the 2-hop (child.nestedSummary) lift would come
// back empty (count 0) while the 1-hop (ownSummary) lift resolves. The test
// asserts both resolve to the seeded data — see the gotcha doc for the
// recorded outcome.
export const handlerCreatedPieceLiftHopsScenario: PatternIntegrationScenario<
  { items?: Array<{ label: string }> }
> = {
  name: "handler-created piece resolves lift at both 1 and 2 hops",
  module: new URL(
    "./handler-created-piece-lift-hops.pattern.ts",
    import.meta.url,
  ),
  exportName: "handlerCreatedPieceLiftHops",
  argument: {
    items: [{ label: "alpha" }, { label: "beta" }, { label: "gamma" }],
  },
  steps: [
    {
      // Before spawning, no viewers exist.
      expect: [
        { path: "viewers", value: [] },
      ],
    },
    {
      events: [{ stream: "spawn", payload: {} }],
      expect: [
        // 1-hop lift, built in the Viewer's own body.
        { path: "viewers.0.ownSummary.count", value: 3 },
        { path: "viewers.0.ownSummary.labels", value: "alpha,beta,gamma" },
        { path: "viewers.0.ownLabel", value: "own:3" },
        // 2-hop lift, built inside the nested Child the Viewer instantiates.
        { path: "viewers.0.child.nestedSummary.count", value: 3 },
        {
          path: "viewers.0.child.nestedSummary.labels",
          value: "alpha,beta,gamma",
        },
        { path: "viewers.0.child.nestedLabel", value: "nested:3" },
      ],
    },
  ],
};

export const scenarios = [handlerCreatedPieceLiftHopsScenario];

describe("handler-created-piece-lift-hops", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
