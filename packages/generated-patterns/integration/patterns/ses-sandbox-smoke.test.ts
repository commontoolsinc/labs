import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

const scenario: PatternIntegrationScenario<{ value?: number }> = {
  name: "ses sandbox smoke",
  module: new URL("./simple-counter.pattern.ts", import.meta.url),
  exportName: "simpleCounter",
  argument: { value: 1 },
  steps: [
    { expect: [{ path: "value", value: 1 }] },
    {
      events: [{ stream: "increment", payload: { amount: 2 } }],
      expect: [{ path: "value", value: 3 }],
    },
  ],
};

describe("ses-sandbox-smoke", () => {
  it(scenario.name, async () => {
    await runPatternScenario(scenario);
  });
});
