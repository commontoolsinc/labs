import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterWithDelayedIncrementScenario: PatternIntegrationScenario<
  { value?: number; pending?: number[] }
> = {
  name: "counter applies increment after compute",
  module: new URL(
    "./counter-delayed-compute.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithDelayedIncrement",
  argument: { value: 0 },
  steps: [
    { expect: [{ path: "value", value: 0 }] },
    {
      events: [{ stream: "schedule", payload: { amount: 2 } }],
      expect: [{ path: "value", value: 2 }],
    },
    {
      events: [
        { stream: "schedule", payload: { amount: 1 } },
        { stream: "schedule", payload: { amount: 3 } },
      ],
      expect: [{ path: "value", value: 6 }],
    },
  ],
};

export const scenarios = [counterWithDelayedIncrementScenario];
