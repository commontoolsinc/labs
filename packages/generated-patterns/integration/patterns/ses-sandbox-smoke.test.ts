import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

const scenario: PatternIntegrationScenario<{ value?: number; step?: number }> = {
  name: "ses sandbox smoke",
  module: new URL("./ses-sandbox-smoke.pattern.ts", import.meta.url),
  exportName: "sesSandboxSmoke",
  argument: { value: 1, step: 2 },
  steps: [
    {
      expect: [
        { path: "value", value: 1 },
        { path: "step", value: 2 },
        { path: "doubled", value: 2 },
        { path: "summary", value: "value:2" },
        { path: "isEven", value: false },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 2 } }],
      expect: [
        { path: "value", value: 3 },
        { path: "doubled", value: 6 },
        { path: "summary", value: "value:6" },
        { path: "isEven", value: false },
      ],
    },
    {
      events: [{ stream: "setStep", payload: { step: 4 } }],
      expect: [
        { path: "step", value: 4 },
      ],
    },
    {
      events: [{ stream: "increment", payload: {} }],
      expect: [
        { path: "value", value: 7 },
        { path: "doubled", value: 14 },
        { path: "summary", value: "value:14" },
        { path: "isEven", value: false },
      ],
    },
  ],
};

describe("ses-sandbox-smoke", () => {
  it(scenario.name, async () => {
    await runPatternScenario(scenario);
  });
});
