import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterWithHistoryScenario: PatternIntegrationScenario<
  { value?: number; history?: number[] }
> = {
  name: "counter records value history",
  module: new URL(
    "./counter-history-tracker.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithHistory",
  argument: { value: 0, history: [] },
  steps: [
    {
      expect: [
        { path: "value", value: 0 },
        { path: "history", value: [] },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 2 } }],
      expect: [
        { path: "value", value: 2 },
        { path: "history", value: [2] },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 3 } }],
      expect: [
        { path: "value", value: 5 },
        { path: "history", value: [2, 5] },
      ],
    },
  ],
};

export const scenarios = [counterWithHistoryScenario];
